// Pure-logic graph derivation for the Phase 2 system orchestration
// planner. Takes a SystemSpec and produces:
//   - the node id list (one per sub_agent)
//   - the directed edges (handoffs) implied by coordination.pattern
//   - the topological execution order
//   - any DAG issues (cycle, dup, unknown ref) — REUSES the Phase 1
//     `validateTaskGraph` (Kahn topological sort) so cycle detection
//     is shared with the agent planner.
//
// This module has NO LLM dependency. It is the canonical, deterministic
// truth about graph shape; the LLM detail pass downstream only fills in
// per-node task descriptions and tool suggestions, never the graph
// itself.

import {
  validateTaskGraph,
  type DagIssue,
  type PlanTask,
} from '@/lib/engine/planner/schema';
import type {
  CoordinationPattern,
  SystemSpec,
} from '../spec';

export interface DerivedEdge {
  from: string;
  to: string;
  payload: string;
}

// OPTIONAL bounded-loop metadata, attached ONLY by the loop_with_break
// pattern's expand(). The graph ITSELF stays acyclic (body subgraph +
// controller, validated by assembleGraph) — the cyclic behaviour lives
// in the runtime executor, which reads this metadata to re-invoke the
// body up to `maxIterations` times. The `backEdge` is metadata, NOT a
// real DerivedEdge: a real back edge would make the DAG cyclic and fail
// validateTaskGraph. Patterns without a loop leave this undefined and
// are completely unaffected.
export interface LoopMetadata {
  // The single node (role 'controller') that decides continue vs break
  // after each body iteration.
  controllerId: string;
  // The body subgraph node ids, in execution order (excludes the controller).
  bodyNodeIds: string[];
  // Hard cap on iterations. Already clamped to [1, ENGINE_LOOP_CEILING]
  // by expand(); the runtime re-clamps as defence in depth.
  maxIterations: number;
  // Natural-language break condition (drives the controller's logic).
  breakCondition: string;
  // The conceptual back edge: each iteration's body ENTRY consumes the
  // PREVIOUS iteration's body TERMINAL output. `from` = body terminal
  // node, `to` = body entry node. Metadata only.
  backEdge: { from: string; to: string };
}

// OPTIONAL selection metadata, attached ONLY by the router pattern's
// expand(). The graph stays ACYCLIC (router -> all branches) — the
// CONDITIONAL SKIP lives in the generated orchestrator, which reads this
// metadata: after the router runs, exactly ONE branch (the subgraph keyed
// by the router's decision) executes; the rest are skipped. There is no
// runtime-model change — it is still ONE governed run; skipped nodes just
// don't execute. Patterns without branch metadata are unaffected.
export interface BranchMetadata {
  // The single node (role 'router') whose decision selects a branch.
  routerId: string;
  // Each branch: the decision key + the node ids (in execution order)
  // that run when that key is selected.
  branches: Array<{ key: string; nodeIds: string[] }>;
}

export interface DerivedGraph {
  nodeIds: string[];
  edges: DerivedEdge[];
  executionOrder: string[];
  // Per-node: which upstream node ids feed it (incoming edges' from-ids).
  upstreamByNode: Record<string, string[]>;
  // Issues from the REUSED Phase 1 cycle check. Empty array = healthy graph.
  issues: DagIssue[];
  // Present ONLY for loop_with_break. Optional + additive — standard +
  // competing_experts never set it.
  loop?: LoopMetadata;
  // Present ONLY for router. Optional + additive.
  branch?: BranchMetadata;
}

export class SystemGraphError extends Error {
  readonly issues: DagIssue[];
  constructor(message: string, issues: DagIssue[]) {
    super(message);
    this.name = 'SystemGraphError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Entry point — derives the graph and validates it. Throws SystemGraphError
// if the graph is malformed (cycle / unknown ref / duplicate id).
// ---------------------------------------------------------------------------
export function deriveGraph(spec: SystemSpec): DerivedGraph {
  const nodeIds = spec.sub_agents.map((a) => a.id);
  const edges = deriveEdges(spec);
  return assembleGraph(nodeIds, edges);
}

// ---------------------------------------------------------------------------
// Pure graph assembly from a node-id list + a derived edge list. Extracted
// from deriveGraph so coordination-pattern expanders (e.g. competing_experts)
// reuse the SAME validation + topo-sort + upstream-map construction —
// there is exactly ONE place that builds a DerivedGraph. deriveGraph
// remains byte-identical (it just hands its edges here).
//
// Runs the REUSED Phase 1 task-graph validator (Kahn topological sort +
// cycle + dup detection). Throws SystemGraphError on a malformed graph.
// ---------------------------------------------------------------------------
export function assembleGraph(
  nodeIds: string[],
  edges: DerivedEdge[],
): DerivedGraph {
  // Build PlanTask-shaped records so we can re-use the Phase 1 task-graph
  // validator (Kahn topological sort + cycle + dup detection). This is the
  // explicit "reuse the cycle check" requirement from the brief.
  // Use Map<> rather than Record<> so noUncheckedIndexedAccess doesn't
  // force narrowing on every read — and so that the "guarantee every
  // node id has an entry" invariant is enforced at construction time.
  const upstream = new Map<string, string[]>();
  for (const id of nodeIds) upstream.set(id, []);
  for (const e of edges) {
    // Skip self-edges before passing to the Kahn check — validateTaskGraph
    // flags them as 'self_dep' but we'd rather raise a SystemGraphError
    // earlier (these come from spec edges that already passed the spec's
    // own validator, but defence in depth).
    if (e.from === e.to) continue;
    const bucket = upstream.get(e.to);
    if (!bucket) continue; // edge.to references unknown id — let the Kahn check surface it cleanly
    if (!bucket.includes(e.from)) bucket.push(e.from);
  }
  const tasks: PlanTask[] = nodeIds.map((id) => ({
    id,
    title: id,
    description: id,
    depends_on: upstream.get(id) ?? [],
  }));

  const issues = validateTaskGraph(tasks);
  if (issues.length > 0) {
    throw new SystemGraphError(
      'orchestration graph rejected: ' +
        issues.map((i) => '[' + i.kind + '] ' + i.message).join('; '),
      issues,
    );
  }

  // Expose the upstream map as a plain object for the rest of the engine
  // (JSON-serialisable; tooling friendly). Every key is guaranteed to be
  // a real node id by construction.
  const upstreamByNode: Record<string, string[]> = {};
  for (const id of nodeIds) upstreamByNode[id] = upstream.get(id) ?? [];

  const executionOrder = topoSort(nodeIds, upstream);

  return {
    nodeIds,
    edges,
    executionOrder,
    upstreamByNode,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// Derive edges from coordination.pattern. The user's spec may have its
// own edges (required for 'dag', optional for the others); we respect
// them when present and synthesise otherwise.
// ---------------------------------------------------------------------------
function deriveEdges(spec: SystemSpec): DerivedEdge[] {
  const explicit = spec.coordination.edges ?? [];
  const pattern: CoordinationPattern = spec.coordination.pattern;
  const ids = spec.sub_agents.map((a) => a.id);

  // Helper: build a payload string from the upstream node's outputs.
  const payloadFor = (fromId: string): string => {
    const a = spec.sub_agents.find((s) => s.id === fromId);
    if (!a || a.outputs.length === 0) return 'handoff';
    const first = a.outputs[0];
    if (a.outputs.length === 1) return first ?? 'handoff';
    return a.outputs.slice(0, 2).join(' + ') + (a.outputs.length > 2 ? ' …' : '');
  };

  switch (pattern) {
    case 'pipeline': {
      if (explicit.length > 0) {
        return explicit.map((e) => ({ from: e.from, to: e.to, payload: payloadFor(e.from) }));
      }
      // Synthesise A → B → C from declaration order. The SystemSpec
      // validator already requires sub_agents.length >= 2 so ids[i-1]
      // and ids[i] are both defined; assert here for the type checker.
      const out: DerivedEdge[] = [];
      for (let i = 1; i < ids.length; i++) {
        const from = ids[i - 1];
        const to = ids[i];
        if (!from || !to) continue;
        out.push({ from, to, payload: payloadFor(from) });
      }
      return out;
    }

    case 'fan_out_in': {
      if (explicit.length > 0) {
        return explicit.map((e) => ({ from: e.from, to: e.to, payload: payloadFor(e.from) }));
      }
      // Synthesise: first node is the coordinator, last is the aggregator,
      // middle nodes are workers fanned out from the coordinator and
      // joined back to the aggregator. Requires at least 3 nodes for a
      // sensible default; with 2 nodes we just chain them.
      if (ids.length < 3) {
        const first = ids[0];
        const second = ids[1];
        if (!first || !second) return [];
        return [
          { from: first, to: second, payload: payloadFor(first) },
        ];
      }
      const head = ids[0];
      const tail = ids[ids.length - 1];
      if (!head || !tail) return [];
      const workers = ids.slice(1, -1);
      const out: DerivedEdge[] = [];
      for (const w of workers) {
        out.push({ from: head, to: w, payload: payloadFor(head) });
        out.push({ from: w, to: tail, payload: payloadFor(w) });
      }
      return out;
    }

    case 'dag':
    default:
      // The spec validator already requires explicit edges for 'dag';
      // SystemSpec.superRefine rejects an empty dag. We just adopt
      // them verbatim here.
      return explicit.map((e) => ({ from: e.from, to: e.to, payload: payloadFor(e.from) }));
  }
}

// ---------------------------------------------------------------------------
// Kahn topological sort over the derived graph. We've already proven
// the graph is acyclic via validateTaskGraph; this just produces a
// deterministic execution order (insertion-order stable; ties broken by
// the order ids appear in nodeIds).
// ---------------------------------------------------------------------------
function topoSort(
  nodeIds: readonly string[],
  upstream: ReadonlyMap<string, readonly string[]>,
): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const id of nodeIds) {
    const deps = upstream.get(id) ?? [];
    for (const dep of deps) {
      const adjDep = adj.get(dep);
      if (adjDep) adjDep.push(id);
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
    }
  }
  // Process nodes in declaration order to keep output stable.
  const queue: string[] = [];
  for (const id of nodeIds) {
    if ((indeg.get(id) ?? 0) === 0) queue.push(id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const nd = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, nd);
      if (nd === 0) queue.push(next);
    }
  }
  // If we exited with fewer than nodeIds.length nodes, the graph had a
  // cycle — but we've already checked that above. Defensive guard so the
  // caller never receives a partial order silently.
  if (order.length !== nodeIds.length) {
    throw new SystemGraphError(
      'unable to compute a topological execution order',
      [{ kind: 'cycle', message: 'topological sort did not cover every node' }],
    );
  }
  return order;
}

// ---------------------------------------------------------------------------
// Step-count check. The "step count" we enforce against SystemSpec.max_steps
// is the number of nodes in the topology — every node is one LLM-bearing
// step at runtime. If the user wants more headroom they can raise
// max_steps in the spec (still bounded by the hard cap).
// ---------------------------------------------------------------------------
export class SystemPlanBudgetError extends Error {
  readonly nodes: number;
  readonly cap: number;
  constructor(nodes: number, cap: number) {
    super(
      'orchestration plan has ' +
        nodes +
        ' nodes but the spec caps max_steps at ' +
        cap,
    );
    this.name = 'SystemPlanBudgetError';
    this.nodes = nodes;
    this.cap = cap;
  }
}

export function assertWithinStepBudget(
  graph: DerivedGraph,
  maxSteps: number,
): void {
  if (graph.nodeIds.length > maxSteps) {
    throw new SystemPlanBudgetError(graph.nodeIds.length, maxSteps);
  }
}
