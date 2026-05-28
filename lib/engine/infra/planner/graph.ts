// Pure-logic graph derivation for the Phase 4 infrastructure planner.
//
// Takes an InfraSpec and produces a base provisioning DAG by composing
// the vetted module catalog (lib/engine/infra/planner/modules.ts) over
// the spec's resources + topology edges:
//
//   network layer        — private_network + service_identity
//                          (shared, every plan emits exactly these two)
//   data layer           — one module per data resource (postgres_db,
//                          object_store, queue), depending on the
//                          private_network step
//   compute layer        — one module per compute resource (worker,
//                          cron, http_service), depending on its
//                          service identity + every data resource it
//                          touches in the spec's topology
//   observability layer  — logs_metrics_pipeline, depending on every
//                          resource step (must wire telemetry last)
//
// The REUSED Phase 1 validateTaskGraph runs over the result so cyclic
// graphs are rejected with a consistent error shape across phases.
// Cycles are not expected from this deterministic mapping but the
// check is run defensively — a refined-by-LLM plan or an exotic spec
// topology could surface one and we want a clean rejection message
// instead of a planner crash.

import {
  validateTaskGraph,
  type DagIssue,
  type PlanTask,
} from '@/lib/engine/planner/schema';
import type { InfraSpec } from '@/lib/engine/infra/spec';
import {
  LAYER_ORDER,
  MODULE_BY_RESOURCE,
  moduleById,
  type InfraModuleId,
  type LayerId,
} from './modules';

export interface InfraDerivedStep {
  id: string;
  layer: LayerId;
  module: InfraModuleId;
  description: string;
  depends_on: string[];
  config: Record<string, unknown>;
  resource_id: string | null;
  secure_defaults: string[];
}

export interface InfraDerivedGraph {
  steps: InfraDerivedStep[];
  executionOrder: string[];
  // Per-step: which upstream step ids feed it. Built from depends_on.
  upstreamByStep: Record<string, string[]>;
  // Issues from the REUSED Phase 1 cycle check. Empty array = healthy
  // (a populated array means the graph was rejected and we threw).
  issues: DagIssue[];
}

export class InfraGraphError extends Error {
  readonly issues: DagIssue[];
  constructor(message: string, issues: DagIssue[]) {
    super(message);
    this.name = 'InfraGraphError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Resource classification — data resources land in the data layer,
// compute resources in the compute layer. Used to pick the right
// dependency direction (compute → data, never the other way).
// ---------------------------------------------------------------------------

// cache + secret_store are data-layer stores (attach to the private
// network, no public endpoint). cdn is a compute-layer edge that fronts an
// origin it depends on via the spec topology.
const DATA_RESOURCE_TYPES = new Set([
  'postgres_db',
  'object_store',
  'queue',
  'cache',
  'secret_store',
]);
const COMPUTE_RESOURCE_TYPES = new Set([
  'worker',
  'cron',
  'http_service',
  'cdn',
]);

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function deriveInfraGraph(spec: InfraSpec): InfraDerivedGraph {
  const steps: InfraDerivedStep[] = [];
  const stepIdByResource = new Map<string, string>();

  // --- 1. Network layer (shared, always emitted) -------------------------
  const networkStepId = 'network_private_subnets';
  steps.push({
    id: networkStepId,
    layer: 'network',
    module: 'private_network',
    description:
      'Provision the private VPC + subnets the rest of the plan attaches to. ' +
      'Nothing is reachable from the public internet unless the spec explicitly opted in.',
    depends_on: [],
    config: spec.region ? { region: spec.region } : {},
    resource_id: null,
    secure_defaults: [...moduleById('private_network').secure_defaults],
  });

  const identityStepId = 'network_service_identity';
  steps.push({
    id: identityStepId,
    layer: 'network',
    module: 'service_identity',
    description:
      'Mint per-resource service accounts with least-privilege IAM. Every ' +
      'workload runs under its own identity — no shared credentials.',
    depends_on: [networkStepId],
    config: {},
    resource_id: null,
    secure_defaults: [...moduleById('service_identity').secure_defaults],
  });

  // --- 2. Data layer -----------------------------------------------------
  // Every data resource gets one provisioning step, depending on the
  // private network. Data steps do NOT depend on each other directly;
  // the spec's topology drives cross-resource wiring, which is mostly
  // a compute-layer concern.
  for (const r of spec.resources) {
    if (!DATA_RESOURCE_TYPES.has(r.type)) continue;
    const stepId = 'data_' + r.id;
    const moduleId = MODULE_BY_RESOURCE[r.type];
    const m = moduleById(moduleId);
    steps.push({
      id: stepId,
      layer: 'data',
      module: moduleId,
      description:
        'Provision ' +
        m.label.toLowerCase() +
        " for resource '" +
        r.id +
        "'. " +
        m.purpose,
      depends_on: [networkStepId, identityStepId],
      config: { ...r.config },
      resource_id: r.id,
      secure_defaults: [...m.secure_defaults],
    });
    stepIdByResource.set(r.id, stepId);
  }

  // --- 3. Compute layer --------------------------------------------------
  // Compute resources depend on:
  //   - the service identity step (per-resource IAM)
  //   - every DATA resource they point at in the spec's topology
  //   - every COMPUTE resource they point at (e.g. cron → worker)
  // The topology edge direction is "from → to" meaning "from depends
  // on to" in the InfraSpec, so we resolve it as: this step depends
  // on each step that provisions a `to` resource.
  for (const r of spec.resources) {
    if (!COMPUTE_RESOURCE_TYPES.has(r.type)) continue;
    const stepId = 'compute_' + r.id;
    const moduleId = MODULE_BY_RESOURCE[r.type];
    const m = moduleById(moduleId);

    const deps: string[] = [identityStepId];
    // Walk the spec's topology — every outgoing edge from this
    // resource means "this resource depends on the target", so the
    // step depends on the target's provisioning step.
    for (const edge of spec.topology) {
      if (edge.from !== r.id) continue;
      const targetStepId = stepIdByResource.get(edge.to);
      if (targetStepId && !deps.includes(targetStepId)) {
        deps.push(targetStepId);
      }
    }

    // Add per-compute-type sizing hints into the step config so the
    // module template can pick them up later. Bounded — we never
    // splat the whole sizing object blindly.
    const cfg: Record<string, unknown> = { ...r.config };
    if (r.sizing) {
      if (r.sizing.instances !== undefined) cfg.instances = r.sizing.instances;
      if (r.sizing.note !== undefined) cfg.sizing_note = r.sizing.note;
    }

    steps.push({
      id: stepId,
      layer: 'compute',
      module: moduleId,
      description:
        'Provision ' +
        m.label.toLowerCase() +
        " for resource '" +
        r.id +
        "'. " +
        m.purpose,
      depends_on: deps,
      config: cfg,
      resource_id: r.id,
      secure_defaults: [...m.secure_defaults],
    });
    stepIdByResource.set(r.id, stepId);
  }

  // Resolve any remaining compute → compute topology edges that pointed
  // at resources whose step ids weren't known when we visited the
  // dependent. (Happens when a compute resource depends on another
  // compute resource declared LATER in spec.resources.) Patch the
  // depends_on lists in a second pass so the order of spec.resources
  // doesn't matter.
  for (const r of spec.resources) {
    if (!COMPUTE_RESOURCE_TYPES.has(r.type)) continue;
    const myStepId = stepIdByResource.get(r.id);
    const myStep = steps.find((s) => s.id === myStepId);
    if (!myStep) continue;
    for (const edge of spec.topology) {
      if (edge.from !== r.id) continue;
      const targetStepId = stepIdByResource.get(edge.to);
      if (targetStepId && !myStep.depends_on.includes(targetStepId)) {
        myStep.depends_on.push(targetStepId);
      }
    }
  }

  // --- 4. Observability layer -------------------------------------------
  // Wire every resource step into a single logs+metrics pipeline. The
  // dependency on every prior step keeps the topo sort honest: this
  // lands last.
  const obsDeps = steps.map((s) => s.id);
  steps.push({
    id: 'observability_pipeline',
    layer: 'observability',
    module: 'logs_metrics_pipeline',
    description:
      'Wire every provisioned resource into the central logs + metrics pipeline. ' +
      'Audit-grade retention; secrets-shaped values redacted.',
    depends_on: obsDeps,
    config: {},
    resource_id: null,
    secure_defaults: [...moduleById('logs_metrics_pipeline').secure_defaults],
  });

  // --- 5. Cycle check (REUSE Phase 1 validateTaskGraph) ------------------
  // Convert InfraDerivedStep → PlanTask shape so we share Kahn topo
  // sort + dup + unknown-dep detection with the agent / system /
  // software planners.
  const planTasks: PlanTask[] = steps.map((s) => ({
    id: s.id,
    title: s.id,
    description: s.description,
    depends_on: s.depends_on,
  }));
  const issues = validateTaskGraph(planTasks);
  if (issues.length > 0) {
    throw new InfraGraphError(
      'infrastructure provisioning graph rejected: ' +
        issues.map((i) => '[' + i.kind + '] ' + i.message).join('; '),
      issues,
    );
  }

  // --- 6. Topological execution order -----------------------------------
  const upstreamByStep: Record<string, string[]> = {};
  for (const s of steps) upstreamByStep[s.id] = [...s.depends_on];

  const executionOrder = topoSort(
    steps.map((s) => s.id),
    upstreamByStep,
    new Map(steps.map((s) => [s.id, s.layer])),
  );

  return {
    steps,
    executionOrder,
    upstreamByStep,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// Kahn topological sort. We've already proven the graph is acyclic via
// validateTaskGraph above; this just produces a deterministic order.
// Within each "ready" wave we sort by the step's layer (network → data
// → compute → observability) so the UI list reads in build-order
// naturally.
// ---------------------------------------------------------------------------

function topoSort(
  stepIds: readonly string[],
  upstream: Record<string, string[]>,
  layerByStep: Map<string, LayerId>,
): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of stepIds) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const id of stepIds) {
    for (const dep of upstream[id] ?? []) {
      const a = adj.get(dep);
      if (a) a.push(id);
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
    }
  }

  function layerScore(id: string): number {
    const layer = layerByStep.get(id);
    return layer ? LAYER_ORDER[layer] : 99;
  }

  const order: string[] = [];
  const remaining = new Set(stepIds);
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      if ((indeg.get(id) ?? 0) === 0) ready.push(id);
    }
    if (ready.length === 0) {
      // Defensive guard — should be unreachable because
      // validateTaskGraph above already ruled out cycles. If it fires,
      // the user sees a clean error instead of a hang.
      throw new InfraGraphError(
        'unable to compute a topological execution order',
        [{ kind: 'cycle', message: 'topological sort did not cover every step' }],
      );
    }
    ready.sort((a, b) => {
      const dl = layerScore(a) - layerScore(b);
      if (dl !== 0) return dl;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const next of adj.get(id) ?? []) {
        indeg.set(next, (indeg.get(next) ?? 0) - 1);
      }
    }
  }
  return order;
}
