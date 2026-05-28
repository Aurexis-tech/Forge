// RETRY-WITH-BACKOFF — bounded retry primitive for external calls
// the engine cannot otherwise harden against transient failure.
//
// CONTRACT
//   - The retried function is given the attempt number (1-indexed).
//     Callers use this to namespace per-attempt context (governance
//     refs, logs).
//   - On throw, the helper calls `classifyError` from errors.ts.
//     If the result is `retriable: true`, it sleeps + retries.
//     Otherwise it throws the classified error immediately —
//     bad_input / auth / governance / not_found never retry.
//   - Defaults: maxAttempts=3, base=500ms, factor=2, cap=10s,
//     jitter=true. Sleep schedule for the defaults: 500ms,
//     1000ms (between attempts 1→2, 2→3).
//   - Honours `retryAfterMs` from the classified error when present
//     — providers know best when they're ready to be talked to
//     again.
//   - Audit hook is optional. When wired, fires per attempt with
//     META ONLY (category + code + attempt + base ref) — never
//     payload data.
//
// HARD INVARIANTS
//   - Retries CANNOT bypass governance. The caller is responsible
//     for re-running `assertAllowed` per attempt (typically by
//     wrapping the whole call body, including the gate, in the
//     retried function). If governance throws mid-loop the next
//     attempt's classified error has `retriable: false` and the
//     loop exits cleanly.
//   - Bounded: maxAttempts cannot exceed MAX_ATTEMPTS_CEILING
//     regardless of caller input — protects against pathological
//     configs.
//   - Pure helper. No DB, no LLM, no I/O of its own (audit hook is
//     OUTBOUND; retry never reaches in).

import { classifyError, type EngineError } from './errors';
import { engineLog } from './log';

const log = engineLog('retry');

// Sanity ceiling. Anything above this is almost certainly a
// misconfiguration; we'd rather throw the classified error than
// burn budget on a runaway loop.
const MAX_ATTEMPTS_CEILING = 6;

// ===========================================================================
// PUBLIC API
// ===========================================================================

export interface RetryAuditEvent {
  /** The classified error from the failed attempt. */
  readonly category: EngineError['category'];
  readonly code: string;
  /** Attempt that JUST failed (1-indexed). */
  readonly attempt: number;
  /** Caller-provided ref so the audit row correlates with the ledger. */
  readonly baseRef: string | null;
  /** Sleep applied before the next attempt, in ms. */
  readonly sleepMs: number;
}

export interface RetryOptions {
  /** Inclusive maximum; default 3, ceiling MAX_ATTEMPTS_CEILING. */
  maxAttempts?: number;
  /** Initial delay between attempt 1 → 2; default 500. */
  baseDelayMs?: number;
  /** Geometric factor; default 2. */
  factor?: number;
  /** Hard ceiling per-sleep; default 10_000. */
  maxDelayMs?: number;
  /** When true, multiply each delay by a uniform [0.5, 1.5] factor. */
  jitter?: boolean;
  /** Audit hook — fires after each failed attempt, BEFORE the sleep. */
  audit?: (event: RetryAuditEvent) => Promise<void> | void;
  /** Caller-provided base ref for the audit event. */
  baseRef?: string | null;
  /**
   * Override sleep — injected by tests so they don't have to wait
   * real time. Default is the global `setTimeout`.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface RetryContext {
  /** 1-indexed attempt number. */
  readonly attempt: number;
  /**
   * Convenience: '' on first attempt, '.retry.N' on subsequent.
   * Used to namespace governance refs / log keys.
   */
  readonly attemptRef: string;
}

/**
 * Runs `fn` with exponential-backoff retry on retriable failures.
 *
 * @param fn The function to retry; receives a RetryContext.
 * @param opts Options.
 * @returns Whatever `fn` returns.
 * @throws The classified EngineError from the FINAL attempt
 *   (or the first non-retriable failure).
 */
export async function withRetry<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const max = Math.min(
    Math.max(1, opts.maxAttempts ?? 3),
    MAX_ATTEMPTS_CEILING,
  );
  const base = Math.max(0, opts.baseDelayMs ?? 500);
  const factor = Math.max(1, opts.factor ?? 2);
  const cap = Math.max(0, opts.maxDelayMs ?? 10_000);
  const jitter = opts.jitter ?? true;
  const sleep = opts.sleepImpl ?? defaultSleep;

  let lastClassified: EngineError | null = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn({
        attempt,
        attemptRef: attempt === 1 ? '' : '.retry.' + (attempt - 1),
      });
    } catch (raw) {
      const classified = classifyError(raw);
      lastClassified = classified;

      // Non-retriable → throw immediately.
      if (!classified.retriable) throw classified;

      // Retriable BUT we've exhausted attempts → throw.
      if (attempt >= max) throw classified;

      // Otherwise: compute sleep, fire audit, wait, loop.
      const sleepMs = computeSleep({
        attempt,
        base,
        factor,
        cap,
        jitter,
        retryAfterMs: classified.retryAfterMs,
      });

      // Structured warning per retry. The audit hook (when wired)
      // also fires below — log here covers the case where no
      // audit hook is configured (most callers).
      log.warn('retry scheduled', {
        category: classified.category,
        code: classified.code,
        attempt,
        ref: opts.baseRef ?? undefined,
        sleepMs,
      });

      if (opts.audit) {
        try {
          await opts.audit({
            category: classified.category,
            code: classified.code,
            attempt,
            baseRef: opts.baseRef ?? null,
            sleepMs,
          });
        } catch {
          // Auditing must never break retry. Swallow silently —
          // the retry loop is more important than the audit row.
        }
      }

      await sleep(sleepMs);
    }
  }

  // Defensive — the for-loop above ALWAYS exits via return or
  // throw; this line is unreachable but TS doesn't know that.
  /* istanbul ignore next */
  throw lastClassified ?? new Error('withRetry: unreachable');
}

// ===========================================================================
// INTERNAL
// ===========================================================================

/** Geometric backoff with optional jitter + retry-after hint. */
function computeSleep(args: {
  attempt: number;
  base: number;
  factor: number;
  cap: number;
  jitter: boolean;
  retryAfterMs: number | undefined;
}): number {
  // Provider-supplied hints take precedence — clamped at cap to
  // avoid pathological values.
  if (typeof args.retryAfterMs === 'number' && args.retryAfterMs >= 0) {
    return Math.min(args.cap, args.retryAfterMs);
  }
  // Geometric: base * factor^(attempt-1). attempt 1 fail → base.
  const geometric = args.base * Math.pow(args.factor, args.attempt - 1);
  const clamped = Math.min(args.cap, geometric);
  if (!args.jitter) return clamped;
  // Multiplicative jitter in [0.5, 1.5]. Bounded by the cap.
  const jittered = clamped * (0.5 + Math.random());
  return Math.min(args.cap, Math.round(jittered));
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
