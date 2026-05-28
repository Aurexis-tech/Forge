// Thin server-only wrapper around the Anthropic SDK.
//
// Centralises:
//  - API key handling (throws clearly if missing)
//  - model + timeout defaults
//  - usage capture (input/output tokens) so every caller can audit cost
//  - GOVERNANCE: every `complete()` call passes through assertAllowed BEFORE
//    the request and recordCost AFTER. No path bypasses this — the only
//    way to talk to the LLM is through this module.
//  - a hard guard against accidental browser imports
//
// Higher layers (spec, planner, codegen, …) call `complete()` and never touch
// the SDK directly. Swap the underlying provider here if needed.

import Anthropic from '@anthropic-ai/sdk';
import { assertAllowed, GovernanceError } from './governance/guard';
import { recordCost } from './governance/ledger';
import { projectedLlmCostUsd } from './governance/pricing';
import { NeedsKeyError, resolveKey } from './keys';
import { withRetry } from './retry';

export const SPEC_MODEL: string =
  process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-6';

// Planning benefits from a stronger reasoner; fall back to the main model if
// the dedicated override isn't set. Kept here so every engine module reads
// model identifiers from one place.
export const PLANNER_MODEL: string =
  process.env.ANTHROPIC_PLANNER_MODEL?.trim() || SPEC_MODEL;

// Codegen benefits from a strong coding model; falls back to the planner
// model, which in turn falls back to the spec model.
export const CODEGEN_MODEL: string =
  process.env.ANTHROPIC_CODEGEN_MODEL?.trim() || PLANNER_MODEL;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 2500;

export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  text: string;
  usage: LLMUsage;
  model: string;
  stop_reason: string | null;
}

export class LLMError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'LLMError';
    this.cause = cause;
  }
}

// Per-key Anthropic client cache. A BYOK Forge has one client per user;
// platform-key Forges have one. Keying by the API key itself means the
// cache hit-rate is naturally per-fuel-source. We don't store more than a
// few entries; in practice each user reuses the same key.
const clientCache = new Map<string, Anthropic>();
const MAX_CACHED_CLIENTS = 32;

function getClient(apiKey: string): Anthropic {
  if (typeof window !== 'undefined') {
    throw new LLMError(
      '[aurexis-forge] LLM client must never run in the browser. ' +
        'Move this call to a server route handler or server action.',
    );
  }
  const cached = clientCache.get(apiKey);
  if (cached) return cached;
  const fresh = new Anthropic({ apiKey });
  if (clientCache.size >= MAX_CACHED_CLIENTS) {
    // Drop the oldest entry to bound memory. Map iteration order is
    // insertion order, so the first key is the oldest.
    const first = clientCache.keys().next().value;
    if (first) clientCache.delete(first);
  }
  clientCache.set(apiKey, fresh);
  return fresh;
}

// Governance scope passed by callers — who is paying for this call.
// `null` user_id means "system-level" (the cron tick, sandbox bootstrap)
// in which case only the global kill switch applies.
export interface GovernanceScope {
  user_id: string | null;
  project_id?: string | null;
  // Free-form identifier the ledger stores under cost_events.ref so a
  // human can trace which extraction / plan / codegen pass this call was.
  ref?: string | null;
}

export interface CompleteOptions {
  system?: string;
  messages: LLMMessage[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  // REQUIRED for every call. Server-only callers must thread this through.
  // If omitted at runtime we treat it as "no user, no project" — which is
  // intentional only for harness work; production callers always pass it.
  governance?: GovernanceScope;
}

export async function complete(opts: CompleteOptions): Promise<LLMResult> {
  const model = opts.model ?? SPEC_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const governance = opts.governance ?? { user_id: null, project_id: null };

  // --- BYOK: who's paying for this call? --------------------------------
  // resolveKey throws NeedsKeyError when REQUIRE_BYOK is on and the user
  // has no connected key. We let it propagate so the route + UI can
  // surface a "connect your key" gate cleanly.
  let resolved;
  try {
    resolved = await resolveKey(governance.user_id, 'anthropic');
  } catch (err) {
    if (err instanceof NeedsKeyError) throw err;
    throw err;
  }
  const anthropic = getClient(resolved.key);

  // --- governance: assertAllowed BEFORE we burn money -------------------
  // assertAllowed + the SDK call run TOGETHER inside the retry loop —
  // each attempt re-checks the kill switch + budget gate (so a flip
  // mid-loop stops further retries) and re-issues the request. The
  // classifier in errors.ts marks GovernanceError + NeedsKeyError +
  // any 4xx (except 429) as non-retriable, so transient 5xx / 429 /
  // network blips are the only things that loop.
  const promptChars =
    (opts.system ?? '').length +
    opts.messages.reduce((acc, m) => acc + m.content.length, 0);

  // The retry loop. The retry helper threads the attempt number +
  // attemptRef ('', '.retry.1', '.retry.2', ...) through, which we
  // append to the ledger ref so each successful billed call lands
  // in cost_events under a distinguishable key.
  const { resp, attemptRef } = await withRetry(
    async (ctx) => {
      // PER-ATTEMPT GATE — every retry re-checks governance.
      await assertAllowed({
        user_id: governance.user_id,
        project_id: governance.project_id ?? null,
        projectedCostUsd: projectedLlmCostUsd({
          model,
          promptChars,
          maxOutputTokens: maxTokens,
        }),
        keySource: resolved.source,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const innerResp = await anthropic.messages.create(
          {
            model,
            max_tokens: maxTokens,
            ...(opts.system ? { system: opts.system } : {}),
            messages: opts.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          },
          { signal: controller.signal },
        );
        return { resp: innerResp, attemptRef: ctx.attemptRef };
      } catch (err) {
        // Preserve the LLMError envelope for downstream callers that
        // catch `LLMError` (the existing public contract). The retry
        // helper's classifier reads `.status` / network shapes off the
        // RAW thrown error, so we attach the original as `cause`
        // before re-throwing — classifyError unwraps via `cause` when
        // necessary; here we throw the raw to keep classification
        // straightforward, then re-wrap as LLMError ONLY when the
        // retry loop has given up.
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      baseRef: governance.ref,
      // 3 attempts: pass-1 + 2 retries. The defaults from retry.ts.
      maxAttempts: 3,
    },
  ).catch((err: unknown) => {
    // The retry helper threw a CLASSIFIED EngineError. Preserve the
    // LLMError public contract for callers that catch it explicitly.
    if (err && typeof err === 'object' && 'message' in err) {
      throw new LLMError(String((err as { message: unknown }).message), err);
    }
    throw new LLMError('LLM request failed', err);
  });

  // Concat every text block (tool_use / thinking blocks contribute nothing
  // here). Using narrowing rather than an SDK-specific type alias keeps
  // this robust across @anthropic-ai/sdk minor version bumps.
  const text = resp.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');

  const usage: LLMUsage = {
    input_tokens: resp.usage.input_tokens,
    output_tokens: resp.usage.output_tokens,
  };

  // --- governance: recordCost AFTER, with REAL usage --------------------
  // Failures inside recordCost are logged but never thrown; the next
  // guard call will block if the ledger is somehow broken. key_source
  // attributes whose fuel this event drew on. The attemptRef (e.g.
  // '.retry.1') suffix is appended so retries are independently
  // visible in cost_events under the same base ref.
  void recordCost({
    user_id: governance.user_id,
    project_id: governance.project_id ?? null,
    kind: 'llm',
    model: resp.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    key_source: resolved.source,
    ref: (governance.ref ?? null) === null
      ? null
      : (governance.ref ?? '') + attemptRef,
  });

  return {
    text,
    usage,
    model: resp.model,
    stop_reason: resp.stop_reason ?? null,
  };
}

export function sumUsage(...parts: LLMUsage[]): LLMUsage {
  return parts.reduce<LLMUsage>(
    (acc, u) => ({
      input_tokens: acc.input_tokens + u.input_tokens,
      output_tokens: acc.output_tokens + u.output_tokens,
    }),
    { input_tokens: 0, output_tokens: 0 },
  );
}
