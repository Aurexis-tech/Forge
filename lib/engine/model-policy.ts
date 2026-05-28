// ============================================================================
//                 MODEL-TIER ROUTING POLICY — TUNE HERE
// ============================================================================
//
// ONE explicit, documented, exhaustive map from engine TASK -> model tier.
// Every LLM call-site in the engine reads its model from `modelForTask()`;
// there are NO stray model-string literals at call-sites. To re-tier a task,
// edit the single `MODEL_POLICY` entry below — nothing else changes.
//
// PHILOSOPHY (read before retuning):
//   - Quality is the priority. This policy CENTRALIZES selection and
//     PRESERVES the prior quality-safe allocation. It does NOT aggressively
//     cheapen tiers — there is no per-task quality data yet.
//   - The codegen family (codegen / repair / refine) is the QUALITY-CRITICAL
//     path: the shipped code. It is PINNED to the `default` (Sonnet) tier and
//     guarded by a structural test (model-policy.test.ts) so a careless future
//     retune cannot silently cheapen it.
//   - Aggressive tuning is DEFERRED to post-validation. The cache-aware cost
//     ledger (cost_events: input/output + cache_creation/cache_read tokens,
//     keyed by `ref` per task) yields real per-task cost on real forges — that
//     is the data source for revisiting any tier below.
//
// ENV OVERRIDES (preserved exactly from the pre-policy behaviour):
//   ANTHROPIC_MODEL          -> base for extraction; cascades to plan + codegen
//   ANTHROPIC_PLANNER_MODEL  -> planning (falls back to ANTHROPIC_MODEL)
//   ANTHROPIC_CODEGEN_MODEL  -> codegen/repair/refine (falls back to planner)
//   CRITIQUE_GATE_MODEL      -> critique
// An operator's env override is an explicit choice and is honoured as-is; the
// codegen guardrail protects the POLICY DATA, not deliberate env overrides.

import {
  CHEAP_LLM_MODEL,
  DEFAULT_LLM_MODEL,
  HEAVY_LLM_MODEL,
} from './governance/pricing';

// ---------------- Task taxonomy (closed set) ------------------------------
// Adding a task here forces a MODEL_POLICY entry (Record exhaustiveness) AND
// a `modelForTask` switch case (TS "not all paths return") — both fail the
// typecheck until wired. That is the exhaustiveness guarantee.
export const MODEL_TASKS = [
  'classify', // intake classifier: agent | system | software | infrastructure
  'extract', // spec extraction (all four molds), incl. its repair retry
  'plan', // build planning (all four molds), incl. its repair retry
  'codegen', // per-file / per-slot generation (all molds) — first pass
  'repair', // codegen self-heal retry after a failed static-check
  'refine', // codegen critique-driven refine pass
  'critique', // critique gate: grades already-compiling code
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

export type ModelTier = 'cheap' | 'default' | 'heavy';

export interface ModelPolicyEntry {
  /** Base tier when no env override is set. The authoritative knob. */
  readonly tier: ModelTier;
  /** One-line justification — why this task sits at this tier. */
  readonly rationale: string;
  /**
   * Quality-critical codegen path. When true the base tier MUST be
   * `default` (Sonnet) or higher and may never be `cheap`. Enforced
   * structurally by model-policy.test.ts so a future retune can't
   * silently cheapen the shipped code.
   */
  readonly codegenCritical?: boolean;
}

export const MODEL_POLICY: Record<ModelTask, ModelPolicyEntry> = {
  classify: {
    tier: 'cheap',
    rationale:
      'Low-stakes 4-way intake label; Zod-validated and fail-soft to "agent". Haiku is ample.',
  },
  extract: {
    tier: 'default',
    rationale:
      'Spec extraction shapes the whole build; structured JSON with a repair retry. Sonnet (unchanged). Post-validation tuning candidate.',
  },
  plan: {
    tier: 'default',
    rationale:
      'Build planning picks scaffold + tasks + tools; structured JSON with a repair retry. Sonnet (unchanged). Post-validation tuning candidate.',
  },
  codegen: {
    tier: 'default',
    rationale:
      'QUALITY-CRITICAL PATH — the code that ships. Pinned to Sonnet; never cheapened.',
    codegenCritical: true,
  },
  repair: {
    tier: 'default',
    rationale:
      'Codegen self-heal retry after a failed static-check. Must match the codegen tier so the fix is as strong as the first pass.',
    codegenCritical: true,
  },
  refine: {
    tier: 'default',
    rationale:
      'Codegen critique-driven refine pass. Must match the codegen tier so quality only ever improves.',
    codegenCritical: true,
  },
  critique: {
    tier: 'cheap',
    rationale:
      'Grades already-compiling code against the QUALITY_BAR; a cheap, bounded reviewer (off by default). Haiku (unchanged).',
  },
};

// ---------------- Resolution ----------------------------------------------

export function tierModel(tier: ModelTier): string {
  switch (tier) {
    case 'cheap':
      return CHEAP_LLM_MODEL;
    case 'default':
      return DEFAULT_LLM_MODEL;
    case 'heavy':
      return HEAVY_LLM_MODEL;
  }
}

function envModel(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

function envChain(...names: string[]): string | null {
  for (const n of names) {
    const v = envModel(n);
    if (v) return v;
  }
  return null;
}

/**
 * The model id for a task. Resolution = the task's env override (with the
 * historical cascade) || the task's base tier model. Reproduces the
 * pre-policy behaviour byte-for-byte:
 *
 *   extract  = ANTHROPIC_MODEL                                   || sonnet
 *   plan     = ANTHROPIC_PLANNER_MODEL || ANTHROPIC_MODEL        || sonnet
 *   codegen  = ANTHROPIC_CODEGEN_MODEL || ANTHROPIC_PLANNER_MODEL
 *              || ANTHROPIC_MODEL                                || sonnet
 *   classify = haiku            (no env override, historically)
 *   critique = CRITIQUE_GATE_MODEL                               || haiku
 */
export function modelForTask(task: ModelTask): string {
  const base = tierModel(MODEL_POLICY[task].tier);
  switch (task) {
    case 'classify':
      return base;
    case 'critique':
      return envModel('CRITIQUE_GATE_MODEL') ?? base;
    case 'extract':
      return envModel('ANTHROPIC_MODEL') ?? base;
    case 'plan':
      return envChain('ANTHROPIC_PLANNER_MODEL', 'ANTHROPIC_MODEL') ?? base;
    case 'codegen':
    case 'repair':
    case 'refine':
      return (
        envChain(
          'ANTHROPIC_CODEGEN_MODEL',
          'ANTHROPIC_PLANNER_MODEL',
          'ANTHROPIC_MODEL',
        ) ?? base
      );
  }
}
