// Unit test: Phase 4 infrastructure provisioning-graph derivation +
// reused Phase 1 cycle check.
//
// `deriveInfraGraph` maps an InfraSpec onto the closed module catalog:
//   - shared network layer: private_network + service_identity
//   - data layer: one module per data resource (postgres / object_store / queue)
//   - compute layer: one module per compute resource (worker / cron / http_service)
//     depending on every data + compute resource it points at via topology
//   - observability layer: logs_metrics_pipeline depending on every resource step
//
// The deterministic mapping has no LLM dependency; these tests cover
// the pure-logic side. The LLM detail pass is exercised separately in
// tests/e2e/infra-planner-dryrun.test.ts.

import { describe, expect, it } from 'vitest';
import {
  InfraGraphError,
  deriveInfraGraph,
} from '@/lib/engine/infra/planner/graph';
import { InfraSpecSchema, type InfraSpec } from '@/lib/engine/infra/spec';
import {
  ProvisioningPlanSchema,
} from '@/lib/engine/infra/planner/schema';
import { validateTaskGraph } from '@/lib/engine/planner/schema';

function makeSpec(overrides: Partial<InfraSpec> = {}): InfraSpec {
  const base = InfraSpecSchema.parse({
    goal: 'A pipeline that ingests events hourly, stores them, and serves them via HTTP.',
    resources: [
      { id: 'event_ingest_cron', type: 'cron', config: { schedule: 'every hour' } },
      {
        id: 'ingest_worker',
        type: 'worker',
        config: { runtime: 'node', concurrency: 2 },
      },
      {
        id: 'events_db',
        type: 'postgres_db',
        config: { schema_hint: 'events table' },
      },
      {
        id: 'events_api',
        type: 'http_service',
        config: { framework: 'nextjs', endpoints: ['/events'] },
      },
    ],
    topology: [
      { from: 'event_ingest_cron', to: 'ingest_worker' },
      { from: 'ingest_worker', to: 'events_db' },
      { from: 'events_api', to: 'events_db' },
    ],
    lifecycle: 'persistent',
  });
  return { ...base, ...overrides } as InfraSpec;
}

describe('deriveInfraGraph', () => {
  it('always emits the shared network layer (private_network + service_identity)', () => {
    const g = deriveInfraGraph(makeSpec());
    const network = g.steps.filter((s) => s.layer === 'network');
    expect(network.map((s) => s.module).sort()).toEqual([
      'private_network',
      'service_identity',
    ]);
    // service_identity depends on private_network.
    const identity = network.find((s) => s.module === 'service_identity');
    expect(identity?.depends_on).toContain('network_private_subnets');
  });

  it('emits one data step per data resource, each depending on the network layer', () => {
    const g = deriveInfraGraph(makeSpec());
    const data = g.steps.filter((s) => s.layer === 'data');
    expect(data.map((s) => s.module).sort()).toEqual(['managed_postgres']);
    // The data step depends on the private network and the identity step.
    const pg = data.find((s) => s.module === 'managed_postgres');
    expect(pg?.depends_on).toContain('network_private_subnets');
    expect(pg?.depends_on).toContain('network_service_identity');
    // resource_id is preserved.
    expect(pg?.resource_id).toBe('events_db');
  });

  it('emits one compute step per compute resource and wires topology dependencies', () => {
    const g = deriveInfraGraph(makeSpec());
    const compute = g.steps.filter((s) => s.layer === 'compute');
    const moduleIds = compute.map((s) => s.module).sort();
    // Three compute resources: cron, worker, http_service.
    expect(moduleIds).toEqual(['container_worker', 'http_service', 'scheduler']);

    // ingest_worker → events_db (topology) means the worker step
    // depends on the events_db data step.
    const worker = compute.find((s) => s.resource_id === 'ingest_worker');
    expect(worker?.depends_on).toContain('data_events_db');

    // events_api → events_db (topology) means the api step depends on
    // the events_db data step too.
    const api = compute.find((s) => s.resource_id === 'events_api');
    expect(api?.depends_on).toContain('data_events_db');

    // event_ingest_cron → ingest_worker (topology) is a compute → compute
    // edge: the cron step depends on the worker step.
    const cron = compute.find((s) => s.resource_id === 'event_ingest_cron');
    expect(cron?.depends_on).toContain('compute_ingest_worker');
  });

  it('emits one observability_pipeline step that depends on every prior step', () => {
    const g = deriveInfraGraph(makeSpec());
    const obs = g.steps.find((s) => s.layer === 'observability');
    expect(obs?.module).toBe('logs_metrics_pipeline');
    const otherIds = g.steps.filter((s) => s.id !== obs?.id).map((s) => s.id);
    for (const id of otherIds) {
      expect(obs?.depends_on).toContain(id);
    }
  });

  it('every step exposes the module catalog\'s secure_defaults', () => {
    const g = deriveInfraGraph(makeSpec());
    for (const s of g.steps) {
      // All catalog modules declare at least one secure default — the
      // step should mirror them so the review UI can render them.
      expect(s.secure_defaults.length).toBeGreaterThan(0);
    }
  });

  it('topological execution order respects all dependencies', () => {
    const g = deriveInfraGraph(makeSpec());
    const pos = (id: string) => g.executionOrder.indexOf(id);
    for (const s of g.steps) {
      for (const dep of s.depends_on) {
        expect(pos(dep)).toBeLessThan(pos(s.id));
      }
    }
    // execution_order is a permutation of step ids.
    expect(g.executionOrder).toHaveLength(g.steps.length);
    expect(new Set(g.executionOrder).size).toBe(g.steps.length);
  });

  it('every step ends up in exactly one of the four declared layers', () => {
    const g = deriveInfraGraph(makeSpec());
    const layers = new Set(['network', 'data', 'compute', 'observability']);
    for (const s of g.steps) {
      expect(layers.has(s.layer)).toBe(true);
    }
  });

  it('handles a single-resource backup-bucket spec with no topology', () => {
    const spec = InfraSpecSchema.parse({
      goal: 'A simple private bucket for nightly backups.',
      resources: [
        {
          id: 'backup_bucket',
          type: 'object_store',
          config: { bucket_hint: 'nightly-backups' },
        },
      ],
      topology: [],
      lifecycle: 'persistent',
    });
    const g = deriveInfraGraph(spec);
    // 2 network + 1 data + 0 compute + 1 observability = 4 steps.
    expect(g.steps).toHaveLength(4);
    expect(g.steps.some((s) => s.module === 'private_object_store')).toBe(true);
  });

  it('preserves region on the network step when the spec sets it', () => {
    const g = deriveInfraGraph(makeSpec({ region: 'eu-west-1' }));
    const network = g.steps.find((s) => s.module === 'private_network');
    expect(network?.config).toEqual({ region: 'eu-west-1' });
  });
});

// ---------------------------------------------------------------------------
// Cycle rejection — proves the REUSED Phase 1 validateTaskGraph fires
// on a hand-crafted cyclic input. The deterministic mapping is acyclic
// by construction; we exercise the path directly via validateTaskGraph
// to confirm the wiring + error shape both behave as expected.
// ---------------------------------------------------------------------------

describe('Phase 1 cycle check (reused by infra planner)', () => {
  it('rejects a two-task cycle with a clean error message', () => {
    const issues = validateTaskGraph([
      {
        id: 'a',
        title: 'A',
        description: 'A depends on B',
        depends_on: ['b'],
      },
      {
        id: 'b',
        title: 'B',
        description: 'B depends on A',
        depends_on: ['a'],
      },
    ]);
    expect(issues.some((i) => i.kind === 'cycle')).toBe(true);
    expect(issues.find((i) => i.kind === 'cycle')?.message).toMatch(/cycle/i);
  });

  it('InfraGraphError preserves the DagIssue array for ops debugging', () => {
    const err = new InfraGraphError('test', [
      { kind: 'cycle', message: 'simulated' },
    ]);
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]?.kind).toBe('cycle');
    expect(err.name).toBe('InfraGraphError');
  });
});

// ---------------------------------------------------------------------------
// Defence — ProvisioningPlanSchema catches structural issues even if
// the deterministic mapping never produces them. A refined-by-LLM plan
// could introduce a duplicate id or a missing execution_order entry.
// ---------------------------------------------------------------------------

describe('ProvisioningPlanSchema', () => {
  it('accepts a fully-derived plan as a sanity check', () => {
    const g = deriveInfraGraph(makeSpec());
    const candidate = {
      catalog_version: 'v1',
      steps: g.steps.map((s) => ({
        id: s.id,
        layer: s.layer,
        module: s.module,
        description: s.description,
        depends_on: s.depends_on,
        config: s.config,
        resource_id: s.resource_id,
        secure_defaults: s.secure_defaults,
      })),
      execution_order: g.executionOrder,
      warnings: [],
    };
    const parsed = ProvisioningPlanSchema.safeParse(candidate);
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown module id (catalog is closed)', () => {
    const candidate = {
      catalog_version: 'v1',
      steps: [
        {
          id: 'oops',
          layer: 'network',
          // 'magic_cloud' is not in INFRA_MODULES — must be rejected.
          module: 'magic_cloud',
          description: 'x',
          depends_on: [],
          config: {},
          resource_id: null,
          secure_defaults: [],
        },
      ],
      execution_order: ['oops'],
      warnings: [],
    };
    const parsed = ProvisioningPlanSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  it('rejects execution_order that is not a permutation of step ids', () => {
    const candidate = {
      catalog_version: 'v1',
      steps: [
        {
          id: 'a',
          layer: 'network',
          module: 'private_network',
          description: 'a',
          depends_on: [],
          config: {},
          resource_id: null,
          secure_defaults: [],
        },
      ],
      execution_order: ['a', 'b'], // 'b' doesn't exist
      warnings: [],
    };
    const parsed = ProvisioningPlanSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  it('rejects a self-edge on a step', () => {
    const candidate = {
      catalog_version: 'v1',
      steps: [
        {
          id: 'a',
          layer: 'network',
          module: 'private_network',
          description: 'a',
          depends_on: ['a'],
          config: {},
          resource_id: null,
          secure_defaults: [],
        },
      ],
      execution_order: ['a'],
      warnings: [],
    };
    const parsed = ProvisioningPlanSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });
});
