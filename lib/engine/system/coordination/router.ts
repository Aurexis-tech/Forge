// The 'router' coordination pattern — SELECTION.
//
// Semantics: a single ROUTER node reads the system input and emits a
// structured decision { branch: <key> }. The system then runs EXACTLY ONE
// downstream branch — the subgraph keyed by that decision — and SKIPS the
// rest. This completes the core control-flow catalog:
//   sequence  (standard)          — run nodes in order
//   ensemble  (competing_experts) — run all, judge picks
//   iteration (loop_with_break)   — re-run a body, controller breaks
//   SELECTION (router)            — run exactly ONE of N branches
//
// Topology: the GENERATED graph stays ACYCLIC. The router fans out to each
// branch's entry node; multi-node branches are chained as a pipeline
// (b0 -> b1 -> ...). assembleGraph runs the SAME validateTaskGraph + topo
// sort the standard path uses, so the result is a valid acyclic DAG and
// the EXISTING generator/orchestrator/sandbox handle it. The CONDITIONAL
// SKIP lives in the generated orchestrator (deterministic, templated): it
// reads the router's decision and executes only the selected branch.
// There is NO runtime-model change — it is still ONE governed run.
//
// Identification: the router is the sub_agent whose role is 'router'
// (case-insensitive); every other sub_agent belongs to exactly one branch.
//
// Constraints (validated at expand time, typed bad_input on violation):
//   - exactly 1 router
//   - spec.router present with >= 2 branches
//   - branch keys distinct
//   - every branch node_id is a real, non-router sub_agent
//   - branches are disjoint AND cover every non-router sub_agent
//     (no overlap, no orphan — every branch reachable, no dead nodes)

import {
  assembleGraph,
  type BranchMetadata,
  type DerivedEdge,
  type DerivedGraph,
} from '../planner/graph';
import { badInputError } from '../../errors';
import type { SystemSpec } from '../spec';
import type { CoordinationPatternDef } from './types';
import { isRouterRole, ROUTER_ROLE } from './roles';

const CONSTRAINT_CODE = 'router_constraint';

function expand(spec: SystemSpec): DerivedGraph {
  const routers = spec.sub_agents.filter((a) => isRouterRole(a.role));
  const nonRouter = spec.sub_agents.filter((a) => !isRouterRole(a.role));

  if (routers.length !== 1) {
    throw badInputError(
      CONSTRAINT_CODE,
      "router requires exactly 1 sub_agent with role '" +
        ROUTER_ROLE +
        "', found " +
        routers.length,
      "A router system needs exactly one sub_agent whose role is 'router'.",
    );
  }
  if (!spec.router) {
    throw badInputError(
      CONSTRAINT_CODE,
      'router requires a `router` block mapping decision keys to branch node ids',
      'A router system needs its branch mapping (which decision key runs which sub_agents).',
    );
  }
  const branches = spec.router.branches;
  if (branches.length < 2) {
    throw badInputError(
      CONSTRAINT_CODE,
      'router requires >= 2 branches, found ' + branches.length,
      'A router system needs at least 2 branches to choose between.',
    );
  }

  // Keys distinct.
  const seenKeys = new Set<string>();
  for (const b of branches) {
    if (seenKeys.has(b.key)) {
      throw badInputError(
        CONSTRAINT_CODE,
        "router branch key '" + b.key + "' is duplicated",
        'Each router branch needs a distinct decision key.',
      );
    }
    seenKeys.add(b.key);
  }

  const router = routers[0]!;
  const nonRouterIds = new Set(nonRouter.map((a) => a.id));

  // Every branch node_id must be a real, non-router sub_agent; branches
  // must be DISJOINT (a node belongs to at most one branch).
  const assigned = new Set<string>();
  for (const b of branches) {
    for (const id of b.node_ids) {
      if (id === router.id) {
        throw badInputError(
          CONSTRAINT_CODE,
          "router branch '" + b.key + "' lists the router node '" + id + "' as a branch node",
          'A router branch cannot include the router node itself.',
        );
      }
      if (!nonRouterIds.has(id)) {
        throw badInputError(
          CONSTRAINT_CODE,
          "router branch '" + b.key + "' references unknown sub_agent id '" + id + "'",
          'A router branch references a sub_agent that does not exist.',
        );
      }
      if (assigned.has(id)) {
        throw badInputError(
          CONSTRAINT_CODE,
          "sub_agent '" + id + "' appears in more than one router branch",
          'Each sub_agent can belong to at most one router branch.',
        );
      }
      assigned.add(id);
    }
  }

  // Every non-router sub_agent must belong to SOME branch (no orphans —
  // every branch reachable, no dead nodes).
  for (const a of nonRouter) {
    if (!assigned.has(a.id)) {
      throw badInputError(
        CONSTRAINT_CODE,
        "sub_agent '" + a.id + "' does not belong to any router branch",
        'Every non-router sub_agent must belong to exactly one branch.',
      );
    }
  }

  // Build the acyclic graph: router -> each branch entry; chain multi-node
  // branches as a pipeline.
  const edges: DerivedEdge[] = [];
  const branchMeta: BranchMetadata['branches'] = [];
  for (const b of branches) {
    const entry = b.node_ids[0]!;
    edges.push({
      from: router.id,
      to: entry,
      payload: router.outputs[0] ?? 'routed_input',
    });
    for (let i = 1; i < b.node_ids.length; i++) {
      const from = b.node_ids[i - 1]!;
      const to = b.node_ids[i]!;
      const sub = spec.sub_agents.find((s) => s.id === from);
      edges.push({ from, to, payload: sub?.outputs[0] ?? 'handoff' });
    }
    branchMeta.push({ key: b.key, nodeIds: [...b.node_ids] });
  }

  // nodeIds preserve declaration order. assembleGraph runs the SAME
  // validateTaskGraph + topo sort — a valid acyclic fan-out DAG.
  const nodeIds = spec.sub_agents.map((a) => a.id);
  const graph = assembleGraph(nodeIds, edges);

  return {
    ...graph,
    branch: {
      routerId: router.id,
      branches: branchMeta,
    },
  };
}

export const ROUTER: CoordinationPatternDef = {
  id: 'router',
  label: 'Router',
  description:
    'A router node reads the input and emits a structured decision selecting ' +
    'EXACTLY ONE downstream branch to run; the other branches are skipped. ' +
    'The graph stays acyclic — the conditional skip is deterministic, in the ' +
    'generated orchestrator. One governed run (no per-iteration model).',
  node_roles: [ROUTER_ROLE],
  expand,
};
