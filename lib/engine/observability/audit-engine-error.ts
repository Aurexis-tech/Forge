// AUDIT-ENRICHMENT HELPER — threads EngineError category / code /
// userMessage into the existing `audit_log.detail` JSONB column so
// the (next-prompt) UI panel + the Forge timeline assembler can
// distinguish a transient blip from a real bug WITHOUT a schema
// change.
//
// PURPOSE
//   - Every catch site that writes an audit row for a failure
//     should funnel through this helper rather than building the
//     detail object by hand. The helper centralises the
//     classification + naming + safety posture.
//
//   - The timeline reads `detail.engine_error_category` and the
//     UI panel reads `detail.engine_error_user_message` —
//     guaranteeing those keys are populated consistently is the
//     point.
//
// SAFETY
//   - Writes to audit_log.detail are META ONLY. The helper writes:
//       engine_error_category, engine_error_code, engine_error_user_message.
//     It does NOT write the raw error.cause (which can carry SDK
//     payloads), and it does NOT echo the full classified
//     EngineError.message (which can carry provider response
//     bodies).
//   - `extra` fields the caller supplies are spread AFTER the
//     engine_error_* keys, but a safety pass guarantees the
//     reserved keys can't be overwritten by `extra` (a malicious
//     or careless caller can't shadow them).
//   - On any DB error the helper SWALLOWS it — auditing must
//     never throw out of a catch block. We log a single warn
//     line via the engine's structured logger so the failure is
//     visible without cascading.

import type { ForgeSupabase } from '@/lib/supabase';
import { classifyError, type ErrorCategory } from '../errors';
import { engineLog } from '../log';

const log = engineLog('audit');

export interface AuditEngineErrorArgs {
  /** Server-only Supabase client. */
  readonly supabase: ForgeSupabase;
  /** Per-project audit_log row's `project_id` field. Null for system-level events. */
  readonly projectId: string | null;
  /**
   * The audit_log action verb (e.g. 'codegen.run_failed',
   * 'sandbox.create_failed'). Follows the existing dot-namespaced
   * convention.
   */
  readonly action: string;
  /** The thrown error to classify + attach. */
  readonly err: unknown;
  /**
   * Free-form additional detail to merge into the audit row.
   * Reserved engine_error_* keys are protected — the merge will
   * NOT let `extra` overwrite them.
   */
  readonly extra?: Record<string, unknown>;
  /** Actor name; defaults to 'engine'. */
  readonly actor?: string;
}

/** Reserved keys the helper writes. `extra` cannot overwrite these. */
export const ENGINE_ERROR_KEYS = [
  'engine_error_category',
  'engine_error_code',
  'engine_error_user_message',
] as const;

export type EngineErrorAuditDetailKey = (typeof ENGINE_ERROR_KEYS)[number];

/** Public for tests: the exact shape the helper writes. */
export interface EngineErrorAuditDetail {
  readonly engine_error_category: ErrorCategory;
  readonly engine_error_code: string;
  readonly engine_error_user_message: string;
}

/**
 * Classify the error and insert an audit_log row whose `detail`
 * JSONB column carries the three `engine_error_*` keys plus any
 * caller-supplied `extra` fields.
 *
 * Returns the classified EngineError so the caller can decide
 * whether to re-throw — many call sites want to do both.
 */
export async function auditEngineError(
  args: AuditEngineErrorArgs,
): Promise<ReturnType<typeof classifyError>> {
  const classified = classifyError(args.err);

  // Build the detail object. Caller's extras land first so the
  // engine_error_* keys are written LAST and definitively win.
  // Defence in depth — even if `extra` happens to contain a
  // colliding key, the spread order guarantees ours overrides.
  const sanitisedExtra = stripReservedKeys(args.extra ?? {});
  const detail: Record<string, unknown> = {
    ...sanitisedExtra,
    engine_error_category: classified.category,
    engine_error_code: classified.code,
    engine_error_user_message: classified.userMessage,
  };

  try {
    const { error } = await args.supabase.from('audit_log').insert({
      project_id: args.projectId,
      action: args.action,
      actor: args.actor ?? 'engine',
      detail,
    });
    if (error) {
      log.warn('audit_log insert failed', {
        action: args.action,
        category: classified.category,
        error: error.message,
      });
    }
  } catch (err) {
    log.warn('audit_log insert threw', {
      action: args.action,
      category: classified.category,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return classified;
}

function stripReservedKeys(
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const reserved = new Set<string>(ENGINE_ERROR_KEYS);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (reserved.has(k)) continue;
    out[k] = v;
  }
  return out;
}
