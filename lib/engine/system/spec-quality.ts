// SYSTEM SPEC ADDENDUM — extends lib/engine/spec/quality.ts.
//
// Engine-owned, eval-referenced (via drift-guard in evals/rubric.ts).
// Mirror of the software codegen addendum pattern exactly.

import type { SpecQualityCriterion } from '../spec/quality';

export const SYSTEM_SPEC_ADDENDUM_VERSION = '1.0.0';

export const SYSTEM_SPEC_ADDENDUM_IDS = [
  'system_coordination_pattern_declared',
  'system_sub_agent_role_and_handoff',
  'system_max_steps_explicit',
] as const;
export type SystemSpecAddendumId = (typeof SYSTEM_SPEC_ADDENDUM_IDS)[number];

export const SYSTEM_SPEC_ADDENDUM: readonly SpecQualityCriterion[] = [
  {
    id: 'system_coordination_pattern_declared',
    label: 'Coordination pattern explicitly declared',
    imperative:
      'Set `coordination.pattern` to one of the catalog values: `pipeline` (strict A→B→C), `fan_out_in` (coordinator dispatches + aggregates), or `dag` (arbitrary DAG; edges REQUIRED). For `dag`, every edge must reference a real sub_agent id. Never leave the pattern implicit.',
    rationale:
      'The orchestrator generator picks its dispatch shape from this enum. An unclear pattern stalls the build at the orchestration step.',
  },
  {
    id: 'system_sub_agent_role_and_handoff',
    label: 'Each sub-agent has a clear role + concrete handoff shape',
    imperative:
      "For every sub_agent, write a role name (`scraper`, `summarizer`, `emailer` — short, descriptive) AND populate `inputs[]` + `outputs[]` with the named payloads it consumes / produces, not vague labels like 'data' or 'result'. The handoff between adjacent sub-agents must be readable as a typed pipeline.",
    rationale:
      'Per-node codegen uses these named payloads to wire imports + validate handoffs. Vague payloads mean the orchestrator emits opaque dispatch code that hides type mismatches until runtime.',
  },
  {
    id: 'system_max_steps_explicit',
    label: 'max_steps set explicitly, sized to the system',
    imperative:
      "Set `max_steps` to a number proportional to the system's complexity (default 25; hard cap 100). Bias low. Do not leave it at the default for a 2-node pipeline; do not push it to the cap for a 3-node pipeline either.",
    rationale:
      'max_steps is the system\'s runaway-budget ceiling. A miscalibrated value either bottoms out cheap runs or blows the budget on a single bad node loop.',
  },
];
