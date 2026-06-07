// ============================================================================
//                PRICING — EDIT HERE BEFORE A REAL RUN
// ============================================================================
// Every cost event runs through this file. Verify rates against the
// provider's current pricing page and update the constants below.
//
//   Anthropic:  https://claude.com/pricing
//   E2B:        https://e2b.dev/pricing
//
// Cost is computed from the REAL `input_tokens` / `output_tokens` the
// Anthropic SDK returns on every response, and the REAL `compute_ms` the
// sandbox runner records when it destroys the VM. See
// lib/engine/llm.ts (`complete()` → recordCost) and
// lib/engine/sandbox/runner.ts (`recordCost('sandbox', compute_ms)`).
//
// Each constant can also be overridden at runtime via env var (handy for
// per-environment tuning without code changes). See env-override note at
// the bottom of this file.

export interface ModelRate {
  /** USD per 1,000,000 input tokens. */
  input_per_mtok: number;
  /** USD per 1,000,000 output tokens. */
  output_per_mtok: number;
}

// ---------------- Anthropic rates (USD per 1M tokens) ----------------------
// Verify at https://claude.com/pricing before going live.

export const CLAUDE_HAIKU_4_5: ModelRate  = { input_per_mtok: 1.00, output_per_mtok:  5.00 };
export const CLAUDE_SONNET_4_6: ModelRate = { input_per_mtok: 3.00, output_per_mtok: 15.00 };
export const CLAUDE_OPUS_4_7: ModelRate   = { input_per_mtok: 5.00, output_per_mtok: 25.00 };

// Map model-id → rate. Add aliases for any other ids you actually invoke.
const MODEL_RATES: Record<string, ModelRate> = {
  'claude-haiku-4-5':  CLAUDE_HAIKU_4_5,
  'claude-sonnet-4-6': CLAUDE_SONNET_4_6,
  'claude-opus-4-7':   CLAUDE_OPUS_4_7,
};

// ---------------- E2B sandbox + runtime (USD per hour) ---------------------
// E2B bills per-second of vCPU + RAM. Pick a per-hour figure that matches
// the sandbox template / size you actually launch. Verify at
// https://e2b.dev/pricing.

export const E2B_SANDBOX_USD_PER_HOUR: number = 0.50;
export const E2B_RUNTIME_USD_PER_HOUR: number = E2B_SANDBOX_USD_PER_HOUR;

// ---------------- Suggested engine defaults --------------------------------
// Sonnet is the canonical engine model — strong reasoning, fair price.
// Haiku is appropriate for short, low-risk, low-stakes steps (small
// summaries, sanity checks, repair retries). Opus only when explicitly
// configured via ANTHROPIC_*_MODEL env vars.

export const DEFAULT_LLM_MODEL = 'claude-sonnet-4-6' as const;
export const CHEAP_LLM_MODEL   = 'claude-haiku-4-5'  as const;
export const HEAVY_LLM_MODEL   = 'claude-opus-4-7'   as const;

// ---------------- Unknown-model fallback -----------------------------------
// Loud (expensive) fallback so an unrecognised model id shows up obviously
// in the ledger rather than silently being free. Override the constants
// here if you want a different policy.

const UNKNOWN_MODEL_FALLBACK: ModelRate = {
  input_per_mtok: 5.0,
  output_per_mtok: 25.0,
};

// ============================================================================
//                          internal — env overrides
// ============================================================================
// Every constant above can be overridden at deploy time without editing
// code:
//
//   PRICING_LLM_INPUT_PER_MTOK_<MODEL_SLUG>   USD per 1M input tokens
//   PRICING_LLM_OUTPUT_PER_MTOK_<MODEL_SLUG>  USD per 1M output tokens
//   PRICING_SANDBOX_USD_PER_HOUR              USD per hour of sandbox compute
//   PRICING_RUNTIME_USD_PER_HOUR              USD per hour of runtime compute
//   PRICING_SANDBOX_USD_PER_SEC               (legacy, same effect but per second)
//   PRICING_RUNTIME_USD_PER_SEC               (legacy, same effect but per second)
//
// <MODEL_SLUG> is the model id uppercased with non-alphanumerics replaced
// by underscores (e.g. CLAUDE_SONNET_4_6).

function envNum(name: string): number | null {
  const v = process.env[name];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function modelSlug(model: string): string {
  return model.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function getModelRate(model: string): ModelRate {
  const slug = modelSlug(model);
  const envIn = envNum('PRICING_LLM_INPUT_PER_MTOK_' + slug);
  const envOut = envNum('PRICING_LLM_OUTPUT_PER_MTOK_' + slug);
  const built = MODEL_RATES[model];
  const fallbackIn =
    envNum('PRICING_LLM_DEFAULT_INPUT_PER_MTOK') ??
    UNKNOWN_MODEL_FALLBACK.input_per_mtok;
  const fallbackOut =
    envNum('PRICING_LLM_DEFAULT_OUTPUT_PER_MTOK') ??
    UNKNOWN_MODEL_FALLBACK.output_per_mtok;
  return {
    input_per_mtok: envIn ?? built?.input_per_mtok ?? fallbackIn,
    output_per_mtok: envOut ?? built?.output_per_mtok ?? fallbackOut,
  };
}

export function getSandboxUsdPerSec(): number {
  const perSec = envNum('PRICING_SANDBOX_USD_PER_SEC');
  if (perSec != null) return perSec;
  const perHour = envNum('PRICING_SANDBOX_USD_PER_HOUR') ?? E2B_SANDBOX_USD_PER_HOUR;
  return perHour / 3600;
}

export function getRuntimeUsdPerSec(): number {
  const perSec = envNum('PRICING_RUNTIME_USD_PER_SEC');
  if (perSec != null) return perSec;
  const perHour = envNum('PRICING_RUNTIME_USD_PER_HOUR') ?? E2B_RUNTIME_USD_PER_HOUR;
  return perHour / 3600;
}

// ============================================================================
//                          cost-computation helpers
// ============================================================================

// Prompt-cache pricing multipliers, relative to the base input rate
// (Anthropic, verified May 2026):
//   - cache READ (a hit / refresh): 0.1x base input
//   - cache WRITE (5-minute TTL):   1.25x base input
// We use the 5-minute write multiplier because complete() writes the
// default (5m) ephemeral cache. Override here if a 1h TTL is adopted
// (2.0x). These are intentionally local constants — the same place the
// base rates live.
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;

export interface LlmCacheTokens {
  /** Tokens written to the cache this call (1.25x base input). */
  cacheCreationTokens?: number;
  /** Tokens read from the cache this call (0.1x base input). */
  cacheReadTokens?: number;
}

/**
 * Compute USD cost from a real LLM response's token counts.
 *
 * `inputTokens` is the UNCACHED input count (post-breakpoint when
 * caching is active) billed at the base rate. The optional cache
 * breakdown is billed at the discounted / surcharged cache rates so the
 * ledger reflects the true cost of a cached call. Omitting the cache
 * argument preserves the original behaviour exactly (back-compat).
 */
export function llmCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache?: LlmCacheTokens,
): number {
  const rate = getModelRate(model);
  const cacheCreation = cache?.cacheCreationTokens ?? 0;
  const cacheRead = cache?.cacheReadTokens ?? 0;
  return (
    (inputTokens / 1_000_000) * rate.input_per_mtok +
    (cacheCreation / 1_000_000) * rate.input_per_mtok * CACHE_WRITE_5M_MULTIPLIER +
    (cacheRead / 1_000_000) * rate.input_per_mtok * CACHE_READ_MULTIPLIER +
    (outputTokens / 1_000_000) * rate.output_per_mtok
  );
}

/** Compute USD cost from a sandbox run's wall-clock duration in ms. */
export function sandboxCostUsd(computeMs: number): number {
  return Math.max(0, computeMs) / 1000 * getSandboxUsdPerSec();
}

/** Compute USD cost from a runtime tick's wall-clock duration in ms. */
export function runtimeCostUsd(computeMs: number): number {
  return Math.max(0, computeMs) / 1000 * getRuntimeUsdPerSec();
}

// Pre-call upper-bound estimate for the governance guard. We don't know
// exact input tokens until the SDK encodes the prompt; estimate from chars
// and assume the model produces near max_tokens of output. Deliberately
// over-estimates so the guard errs toward blocking close-to-cap callers.
export function projectedLlmCostUsd(args: {
  model: string;
  promptChars: number;
  maxOutputTokens: number;
}): number {
  const estInputTokens = Math.ceil(args.promptChars / 3.5);
  return llmCostUsd(args.model, estInputTokens, args.maxOutputTokens);
}

export function projectedComputeCostUsd(
  kind: 'sandbox' | 'runtime',
  expectedMs: number,
): number {
  return kind === 'sandbox'
    ? sandboxCostUsd(expectedMs)
    : runtimeCostUsd(expectedMs);
}

// ============================================================================
//                       TOKEN WALLET — USD ↔ tokens
// ============================================================================
// The prepaid wallet is denominated in TOKENS. LLM usage debits the real
// token count 1:1. Everything else the platform meters (sandbox, runtime,
// infra) is naturally priced in USD, so it converts into the SAME token unit
// at this reference rate — one balance meters the whole platform.
//
// This rate is ALSO the implied sell price you set top-up packages against:
// at $8 / 1M tokens, a 5M-token package "costs" ~$40 of platform value. Put
// your margin in the package price (lib/engine/governance/token-packages.ts).
// Override at deploy time with PRICING_TOKENS_USD_PER_MTOK.

export const TOKENS_USD_PER_MTOK = 8.0;

export function tokensUsdPerMtok(): number {
  return envNum('PRICING_TOKENS_USD_PER_MTOK') ?? TOKENS_USD_PER_MTOK;
}

/**
 * Convert a USD cost into wallet token-equivalents. Rounds UP so the platform
 * never under-bills compute, and never returns negative.
 */
export function usdToTokens(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  const perMtok = tokensUsdPerMtok();
  if (perMtok <= 0) return 0;
  return Math.ceil((usd / perMtok) * 1_000_000);
}

/** Inverse: a token balance expressed as an approximate USD value (display). */
export function tokensToUsd(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * tokensUsdPerMtok();
}
