// ENGINE ERROR TAXONOMY — the foundation for reliability /
// observability. Every later improvement (observability dashboards,
// edge-case hardening, UI error surfacing, retry tuning) gets
// easier once errors are CATEGORIZED here.
//
// HARD INVARIANTS
//   - Additive only. Existing throw sites keep working — the
//     existing typed errors (GovernanceError, NeedsKeyError, etc.)
//     continue to throw, and the classifier maps them into
//     EngineError on demand. Existing catch-Error sites still
//     catch the new EngineError because EngineError extends Error.
//
//   - Eight categories — stable, never renamed. Adding a new
//     category is a deliberate addition to the union. Code id
//     ('budget_exceeded', 'anthropic_5xx', 'malformed_json') is
//     the FINE grain; category is the COARSE grain.
//
//   - `retriable` is the contract with lib/engine/retry.ts. Only
//     transient_provider entries are retriable by default;
//     specific overrides (e.g. a 429 with Retry-After) can carry
//     a hint. Categories that touch USER input (bad_input, auth,
//     permission, governance, not_found) are NEVER retriable —
//     the input must change before the call could succeed.
//
//   - `userMessage` is short, human-friendly, safe to surface in
//     the UI. The full `message` is for logs + audit + dev only;
//     never echo it to end users.
//
//   - evals/ NEVER imports this. The retry helper + taxonomy are
//     engine-internal; the eval surface treats throws as opaque.

import { GovernanceError } from './governance/guard';
import { NeedsKeyError } from './keys';

// ===========================================================================
// CATEGORY UNION
// ===========================================================================
export const ERROR_CATEGORIES = [
  /** Kill switch active, budget exceeded. Existing GovernanceError. */
  'governance',
  /** BYOK key missing / invalid, OAuth token expired, connection revoked. */
  'auth',
  /** Spec invalid, Zod schema failure, user-supplied data malformed. */
  'bad_input',
  /** Project / build / spec / file doesn't exist (or RLS-hidden). */
  'not_found',
  /** RLS denial / explicit authorization-gate failure. */
  'permission',
  /** Anthropic 5xx/429, network timeout, E2B/GitHub/Vercel/Supabase/cloud transient. */
  'transient_provider',
  /** 4xx (non-auth), malformed response shape, schema-incompatible reply. */
  'permanent_provider',
  /** Unexpected (the catch-all). */
  'internal',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

// ===========================================================================
// EngineError CLASS
// ===========================================================================
export interface EngineErrorInit {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly userMessage: string;
  readonly cause?: unknown;
  readonly retriable: boolean;
  readonly retryAfterMs?: number;
}

export class EngineError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly userMessage: string;
  readonly retriable: boolean;
  readonly retryAfterMs?: number;
  // We hold the original wrapped error here so the classifier can
  // unwrap when called on an already-classified EngineError, and
  // so logs can see the source.
  readonly cause?: unknown;

  constructor(init: EngineErrorInit) {
    super(init.message);
    this.name = 'EngineError';
    this.category = init.category;
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.retriable = init.retriable;
    this.retryAfterMs = init.retryAfterMs;
    this.cause = init.cause;
  }
}

// ===========================================================================
// CLASSIFIER — the only public entry point besides EngineError itself.
// Recognises Anthropic SDK errors, Zod errors, Postgres/Supabase
// errors, AbortError + fetch failures, existing engine typed
// errors, and falls back to 'internal' with the original message
// preserved.
// ===========================================================================
export function classifyError(err: unknown): EngineError {
  // Already classified — pass through unchanged.
  if (err instanceof EngineError) return err;

  // Existing engine typed errors mapped to the taxonomy.
  if (err instanceof GovernanceError) {
    return new EngineError({
      category: 'governance',
      code: 'governance_' + err.reason,
      message: err.message,
      userMessage:
        err.reason === 'killed'
          ? 'The Forge is paused — try again once the kill switch is cleared.'
          : 'The project has hit its budget — raise the budget or wait for the next billing window.',
      cause: err,
      retriable: false,
    });
  }
  if (err instanceof NeedsKeyError) {
    return new EngineError({
      category: 'auth',
      code: 'needs_key_' + err.provider,
      message: err.message,
      userMessage:
        'A required API key is not configured. Connect a ' +
        err.provider +
        ' key under /settings/keys before retrying.',
      cause: err,
      retriable: false,
    });
  }

  // Zod errors — schema validation failures.
  if (isZodError(err)) {
    const issues = (err as { issues: ReadonlyArray<{ path: ReadonlyArray<unknown>; message: string }> })
      .issues;
    const summary = issues
      .slice(0, 4)
      .map(
        (i) =>
          (i.path.length === 0 ? '(root)' : i.path.join('.')) + ': ' + i.message,
      )
      .join('; ');
    return new EngineError({
      category: 'bad_input',
      code: 'zod_validation',
      message: 'schema validation failed: ' + summary,
      userMessage:
        'The supplied data did not match the expected shape — adjust your input and try again.',
      cause: err,
      retriable: false,
    });
  }

  // HTTP-shaped errors: Anthropic SDK, Octokit, Vercel/Supabase
  // fetch wrappers. Duck-type on `.status`.
  const status = readStatus(err);
  if (status !== null) {
    const retryAfterMs = readRetryAfterMs(err);
    if (status === 401 || status === 403) {
      return new EngineError({
        category: 'auth',
        code: 'http_' + status,
        message: 'auth failure (HTTP ' + status + '): ' + describeError(err),
        userMessage:
          'The provider rejected the credential. Re-connect your key or token.',
        cause: err,
        retriable: false,
      });
    }
    if (status === 404) {
      return new EngineError({
        category: 'not_found',
        code: 'http_404',
        message: 'not found (HTTP 404): ' + describeError(err),
        userMessage: 'The requested resource was not found.',
        cause: err,
        retriable: false,
      });
    }
    if (status === 400 || status === 422) {
      return new EngineError({
        category: 'bad_input',
        code: 'http_' + status,
        message: 'bad input (HTTP ' + status + '): ' + describeError(err),
        userMessage:
          'The provider rejected the request shape. Adjust the input and try again.',
        cause: err,
        retriable: false,
      });
    }
    if (status === 429 || (status >= 500 && status <= 599)) {
      return new EngineError({
        category: 'transient_provider',
        code: status === 429 ? 'http_429' : 'http_5xx',
        message:
          'transient provider failure (HTTP ' + status + '): ' + describeError(err),
        userMessage:
          'The provider is temporarily unavailable. Retrying automatically.',
        cause: err,
        retriable: true,
        retryAfterMs,
      });
    }
    // Other 4xx — permanent_provider (server response we cannot
    // reasonably retry against).
    return new EngineError({
      category: 'permanent_provider',
      code: 'http_' + status,
      message: 'provider error (HTTP ' + status + '): ' + describeError(err),
      userMessage:
        'The provider returned an error we cannot recover from. Contact support.',
      cause: err,
      retriable: false,
    });
  }

  // Postgres / Supabase errors — duck-type on the `.code` Postgres
  // SQLSTATE shape (5 chars: digits + letters) and PostgREST 'PGRST*' ids.
  const pgCode = readPgCode(err);
  if (pgCode !== null) {
    // Unique violation → bad input from the user (duplicate).
    if (pgCode === '23505') {
      return new EngineError({
        category: 'bad_input',
        code: 'pg_unique_violation',
        message: 'unique-constraint violation: ' + describeError(err),
        userMessage: 'A record with that value already exists.',
        cause: err,
        retriable: false,
      });
    }
    // PGRST116 = "Results contain 0 rows" (PostgREST) — treat as not_found
    // unless the caller meant maybeSingle, in which case caller checks data === null.
    if (pgCode === 'PGRST116') {
      return new EngineError({
        category: 'not_found',
        code: 'pg_no_rows',
        message: 'no rows returned: ' + describeError(err),
        userMessage: 'The requested record was not found.',
        cause: err,
        retriable: false,
      });
    }
    // RLS violations — Postgres reports 42501 (insufficient_privilege).
    if (pgCode === '42501') {
      return new EngineError({
        category: 'permission',
        code: 'pg_rls_denial',
        message: 'RLS / privilege denial: ' + describeError(err),
        userMessage:
          "You don't have access to this resource. Sign in as the owner or check your project membership.",
        cause: err,
        retriable: false,
      });
    }
    // Other Postgres errors — typically transient (deadlock retries
    // are sometimes useful), but we err on the side of safety and
    // mark them internal. Manual retry only.
    return new EngineError({
      category: 'internal',
      code: 'pg_' + pgCode,
      message: 'postgres error ' + pgCode + ': ' + describeError(err),
      userMessage: 'A database error occurred. Please try again.',
      cause: err,
      retriable: false,
    });
  }

  // Network-layer errors — AbortError, ECONNRESET, ETIMEDOUT, etc.
  if (isNetworkTransient(err)) {
    return new EngineError({
      category: 'transient_provider',
      code: 'network_transient',
      message: 'network transient: ' + describeError(err),
      userMessage:
        'The network call timed out or dropped. Retrying automatically.',
      cause: err,
      retriable: true,
    });
  }

  // Last resort: preserve message but classify as internal.
  return new EngineError({
    category: 'internal',
    code: 'unexpected',
    message: describeError(err),
    userMessage:
      'An unexpected engine error occurred. The Forge has captured the details — please try again, and if it persists, file a bug.',
    cause: err,
    retriable: false,
  });
}

// ===========================================================================
// FACTORIES — convenience for engine code that wants to THROW an
// EngineError directly rather than relying on the classifier.
// Keeps the call sites readable and the codes consistent.
// ===========================================================================

/**
 * Build a `bad_input` error from a free-form reason. Use when an
 * engine-level invariant is violated by user-supplied data and you
 * want to surface a specific code other than 'zod_validation'.
 */
export function badInputError(
  code: string,
  message: string,
  userMessage?: string,
): EngineError {
  return new EngineError({
    category: 'bad_input',
    code,
    message,
    userMessage: userMessage ?? 'The supplied input is invalid.',
    retriable: false,
  });
}

/** Build a `not_found` error. */
export function notFoundError(
  code: string,
  message: string,
  userMessage?: string,
): EngineError {
  return new EngineError({
    category: 'not_found',
    code,
    message,
    userMessage: userMessage ?? 'The requested resource was not found.',
    retriable: false,
  });
}

/** Build an `internal` error from an unexpected condition. */
export function internalError(
  code: string,
  message: string,
  cause?: unknown,
): EngineError {
  return new EngineError({
    category: 'internal',
    code,
    message,
    userMessage:
      'An unexpected engine error occurred. Please try again, and if it persists, file a bug.',
    cause,
    retriable: false,
  });
}

// ===========================================================================
// INTERNAL HELPERS — duck-typing detectors.
// ===========================================================================

function isZodError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; issues?: unknown };
  return e.name === 'ZodError' && Array.isArray(e.issues);
}

/**
 * Read an HTTP status code off an error, handling the various
 * shapes the SDKs use:
 *   - Anthropic SDK: `.status` (number)
 *   - Octokit: `.status`
 *   - generic fetch wrappers: `.status` or `.statusCode`
 */
function readStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { status?: unknown; statusCode?: unknown };
  if (typeof e.status === 'number' && Number.isFinite(e.status)) return e.status;
  if (typeof e.statusCode === 'number' && Number.isFinite(e.statusCode))
    return e.statusCode;
  return null;
}

/**
 * Read a Retry-After hint (in milliseconds) from a provider error.
 * Supports both the SDK-attached `retryAfter` numeric (seconds) and
 * the `headers['retry-after']` string form.
 */
function readRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as {
    retryAfter?: unknown;
    headers?: unknown;
    response?: unknown;
  };
  if (typeof e.retryAfter === 'number' && Number.isFinite(e.retryAfter)) {
    // Seconds → ms.
    return Math.max(0, Math.round(e.retryAfter * 1000));
  }
  const headers = readHeaders(e.headers) ?? readHeaders((e.response as { headers?: unknown } | undefined)?.headers);
  if (headers) {
    const raw = headers['retry-after'];
    if (typeof raw === 'string') {
      const asNum = Number.parseInt(raw, 10);
      if (Number.isFinite(asNum) && asNum >= 0) return asNum * 1000;
      const asDate = Date.parse(raw);
      if (Number.isFinite(asDate)) {
        const ms = asDate - Date.now();
        if (ms > 0) return ms;
      }
    }
  }
  return undefined;
}

function readHeaders(h: unknown): Record<string, string> | null {
  if (!h) return null;
  if (typeof h === 'object') {
    // Plain object headers (lowercase or mixed case).
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (typeof v === 'string') result[k.toLowerCase()] = v;
    }
    return result;
  }
  return null;
}

function readPgCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown };
  if (typeof e.code !== 'string') return null;
  // Postgres SQLSTATE: 5 alphanumeric characters.
  if (/^[A-Z0-9]{5}$/.test(e.code)) return e.code;
  // PostgREST codes (PGRST### family).
  if (/^PGRST\d+$/.test(e.code)) return e.code;
  return null;
}

function isNetworkTransient(err: unknown): boolean {
  if (!err) return false;
  if (typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'AbortError') return true;
  if (typeof e.code === 'string') {
    if (
      e.code === 'ECONNRESET' ||
      e.code === 'ECONNREFUSED' ||
      e.code === 'ETIMEDOUT' ||
      e.code === 'ENOTFOUND' ||
      e.code === 'EAI_AGAIN' ||
      e.code === 'EPIPE'
    ) {
      return true;
    }
  }
  if (typeof e.message === 'string') {
    if (
      /fetch failed/i.test(e.message) ||
      /network error/i.test(e.message) ||
      /timed out/i.test(e.message) ||
      /aborted/i.test(e.message)
    ) {
      return true;
    }
  }
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Re-export the engine's pre-existing typed errors so callers can
// `import { EngineError, GovernanceError, NeedsKeyError } from
// '@/lib/engine/errors'` without reaching into the individual
// modules. The classifier handles either.
export { GovernanceError } from './governance/guard';
export { NeedsKeyError } from './keys';
