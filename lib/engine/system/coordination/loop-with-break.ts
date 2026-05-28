// The 'loop_with_break' coordination pattern.
//
// Semantics: the sub_agents form a small BODY subgraph plus a single
// CONTROLLER. The runtime re-invokes the body subgraph, then runs the
// controller, which emits a structured decision { decision:
// 'continue' | 'break' }. The loop stops on the FIRST of:
//   - the controller deciding 'break' (the break_condition is satisfied), OR
//   - a hard `max_iterations` cap, OR
//   - a per-iteration governance block (budget / kill switch).
//
// This is the FIRST pattern that extends the runtime beyond a flat DAG
// into BOUNDED ITERATION. It is bounded TWO ways:
//   - by COUNT: max_iterations is a hard ceiling (clamped to
//     ENGINE_LOOP_CEILING here, re-clamped in the runtime helper); a loop
//     can never exceed it regardless of what the controller decides.
//   - by COST: every iteration passes through assertAllowed + the
//     kill-switch check before it runs and records its own ledger event.
//
// Topology: the GENERATED graph stays ACYCLIC. The body nodes are chained
// in declaration order (b0 → b1 → … → b_{k-1}) and the last body node
// hands off to the controller (b_{k-1} → controller). assembleGraph runs
// the SAME validateTaskGraph + topo sort the standard path uses, so the
// body subgraph + controller is a valid acyclic DAG and the EXISTING
// per-node generator + orchestrator + sandbox handle it unchanged. The
// CYCLE lives only as loop METADATA (the back edge), consumed by the
// runtime executor — a real back edge would fail validateTaskGraph.
//
// Identification: the controller is the sub_agent whose role is
// 'controller' (case-insensitive); every other sub_agent is a body node.
//
// Constraints (validated at expand time, typed bad_input on violation):
//   - exactly 1 controller
//   - >= 1 body node
//   - spec.loop present with 1 <= max_iterations <= ENGINE_LOOP_CEILING

import { assembleGraph, type DerivedEdge, type DerivedGraph } from '../planner/graph';
import { badInputError } from '../../errors';
import { ENGINE_LOOP_CEILING, type SystemSpec } from '../spec';
import type { CoordinationPatternDef } from './types';
import { CONTROLLER_ROLE, isControllerRole } from './roles';

const CONSTRAINT_CODE = 'loop_with_break_constraint';

function expand(spec: SystemSpec): DerivedGraph {
  const controllers = spec.sub_agents.filter((a) => isControllerRole(a.role));
  const body = spec.sub_agents.filter((a) => !isControllerRole(a.role));

  if (controllers.length !== 1) {
    throw badInputError(
      CONSTRAINT_CODE,
      "loop_with_break requires exactly 1 sub_agent with role '" +
        CONTROLLER_ROLE +
        "', found " +
        controllers.length,
      "A loop-with-break system needs exactly one sub_agent whose role is 'controller'.",
    );
  }
  if (body.length < 1) {
    throw badInputError(
      CONSTRAINT_CODE,
      'loop_with_break requires >= 1 body sub_agent, found ' + body.length,
      'A loop-with-break system needs at least one body sub_agent plus a controller.',
    );
  }
  if (!spec.loop) {
    throw badInputError(
      CONSTRAINT_CODE,
      'loop_with_break requires a `loop` block with max_iterations + break_condition',
      'A loop-with-break system needs its loop parameters (max_iterations + break_condition).',
    );
  }
  const requested = spec.loop.max_iterations;
  if (!Number.isInteger(requested) || requested < 1 || requested > ENGINE_LOOP_CEILING) {
    throw badInputError(
      CONSTRAINT_CODE,
      'loop_with_break max_iterations must be an integer in [1, ' +
        ENGINE_LOOP_CEILING +
        '], got ' +
        String(requested),
      'A loop-with-break system can run between 1 and ' +
        ENGINE_LOOP_CEILING +
        ' iterations.',
    );
  }

  const controller = controllers[0]!;

  // Chain the body in declaration order: b0 → b1 → … → b_{k-1}.
  const edges: DerivedEdge[] = [];
  for (let i = 1; i < body.length; i++) {
    const from = body[i - 1]!;
    const to = body[i]!;
    edges.push({ from: from.id, to: to.id, payload: from.outputs[0] ?? 'handoff' });
  }
  // The body's terminal node hands off to the controller.
  const bodyTerminal = body[body.length - 1]!;
  const bodyEntry = body[0]!;
  edges.push({
    from: bodyTerminal.id,
    to: controller.id,
    payload: bodyTerminal.outputs[0] ?? 'body_output',
  });

  // nodeIds preserve declaration order. assembleGraph validates the
  // acyclic body+controller DAG (Kahn + topo) exactly like the standard
  // path — no new downstream machinery.
  const nodeIds = spec.sub_agents.map((a) => a.id);
  const graph = assembleGraph(nodeIds, edges);

  return {
    ...graph,
    loop: {
      controllerId: controller.id,
      bodyNodeIds: body.map((b) => b.id),
      maxIterations: requested,
      breakCondition: spec.loop.break_condition,
      // Back edge: next iteration's body ENTRY consumes the previous
      // iteration's body TERMINAL output. Metadata only — never a real edge.
      backEdge: { from: bodyTerminal.id, to: bodyEntry.id },
    },
  };
}

export const LOOP_WITH_BREAK: CoordinationPatternDef = {
  id: 'loop_with_break',
  label: 'Loop with break',
  description:
    'A controller re-invokes a body subgraph until a natural-language break ' +
    'condition is met OR a hard max-iterations cap is reached. Bounded by count ' +
    '(max_iterations) AND by cost (per-iteration budget + kill-switch checks). ' +
    'The generated graph stays acyclic — the loop is runtime metadata.',
  node_roles: [CONTROLLER_ROLE],
  expand,
};
