// The 'competing_experts' coordination pattern.
//
// Semantics: N expert agents independently attempt the SAME task (each
// consumes the system input); a single JUDGE node evaluates the N
// candidate outputs and selects OR synthesises the best.
//
// Topology: fan-out to a single sink. Each expert is a root (indegree 0,
// fed by the external trigger); the judge depends on ALL experts. This
// is a valid acyclic DAG, so the EXISTING planner + validateTaskGraph +
// per-node generator + sandbox + runtime + presentation all handle it
// unchanged — competing_experts adds no new downstream machinery.
//
// Identification: the judge is the sub_agent whose role is 'judge'
// (case-insensitive); every other sub_agent is an expert.
//
// Constraints (validated at expand time, typed bad_input on violation):
//   - >= 2 experts
//   - exactly 1 judge

import { assembleGraph, type DerivedEdge, type DerivedGraph } from '../planner/graph';
import { badInputError } from '../../errors';
import type { SystemSpec } from '../spec';
import type { CoordinationPatternDef } from './types';
import { isJudgeRole, JUDGE_ROLE } from './roles';

function expand(spec: SystemSpec): DerivedGraph {
  const judges = spec.sub_agents.filter((a) => isJudgeRole(a.role));
  const experts = spec.sub_agents.filter((a) => !isJudgeRole(a.role));

  if (experts.length < 2) {
    throw badInputError(
      'competing_experts_constraint',
      'competing_experts requires >= 2 expert sub_agents, found ' + experts.length,
      'A competing-experts system needs at least 2 experts plus a judge.',
    );
  }
  if (judges.length !== 1) {
    throw badInputError(
      'competing_experts_constraint',
      "competing_experts requires exactly 1 sub_agent with role '" +
        JUDGE_ROLE +
        "', found " +
        judges.length,
      "A competing-experts system needs exactly one sub_agent whose role is 'judge'.",
    );
  }

  const judge = judges[0]!;
  // Fan-out: every expert hands its candidate to the judge. The experts
  // themselves have no upstream — they each consume the external input.
  const edges: DerivedEdge[] = experts.map((e) => ({
    from: e.id,
    to: judge.id,
    payload: e.outputs[0] ?? 'candidate',
  }));

  // nodeIds preserve declaration order (experts + judge interleaved as
  // declared). assembleGraph runs the SAME validateTaskGraph + topo sort
  // the standard path uses — the result is a valid acyclic DAG.
  const nodeIds = spec.sub_agents.map((a) => a.id);
  return assembleGraph(nodeIds, edges);
}

export const COMPETING_EXPERTS: CoordinationPatternDef = {
  id: 'competing_experts',
  label: 'Competing experts',
  description:
    'N expert agents independently attempt the SAME task; a judge evaluates ' +
    'the N candidate outputs and selects or synthesises the best. Fan-out to a ' +
    'single judge (acyclic).',
  node_roles: [JUDGE_ROLE],
  expand,
};
