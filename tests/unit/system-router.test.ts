// router expand() — the deterministic graph layer + the generated
// orchestrator's conditional skip.
//
// Hermetic, no LLM: the pattern produces an ACYCLIC router→branches DAG
// (so the existing generator/orchestrator/sandbox handle it unchanged)
// PLUS branch METADATA (the conditional skip lives in the deterministic
// orchestrator).
//   - catalog registration lists router + its router role
//   - expand() → router → branch entries, acyclic, with branch metadata
//   - constraints (typed bad_input): router/branch counts, keys, coverage
//   - the GENERATED orchestrator (router plan) inlines the skip + parses
//   - backward compat: standard graphs carry NO branch metadata

import { afterEach, describe, expect, it } from 'vitest';
import {
  ensurePatternsRegistered,
  expandCoordination,
  getPattern,
  isRouterRole,
  ROUTER_ROLE,
  listPatterns,
  _resetPatternsForTests,
} from '@/lib/engine/system/coordination';
import { SystemSpecSchema, type SystemSpec } from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationNode,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';
import { generateOrchestratorSource } from '@/lib/engine/system/codegen/orchestrator';
import { staticCheckFile } from '@/lib/engine/codegen/staticcheck';
import { EngineError } from '@/lib/engine/errors';

afterEach(() => {
  _resetPatternsForTests();
  ensurePatternsRegistered();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function routerSpec(opts: {
  routers?: number;
  branches?: Array<{ key: string; node_ids: string[] }>;
  extraNodes?: string[];
  withRouterField?: boolean;
} = {}): SystemSpec {
  const routers = opts.routers ?? 1;
  const branches = opts.branches ?? [
    { key: 'alpha', node_ids: ['a'] },
    { key: 'beta', node_ids: ['b'] },
    { key: 'gamma', node_ids: ['c'] },
  ];
  const branchNodeIds = Array.from(
    new Set(branches.flatMap((b) => b.node_ids)),
  );
  const subAgents: SystemSpec['sub_agents'] = [];
  for (let i = 0; i < routers; i++) {
    subAgents.push({
      id: 'route' + (i === 0 ? '' : '_' + i),
      role: 'router',
      description: 'classifies the input and selects a branch',
      inputs: ['request'],
      outputs: ['routed'],
    });
  }
  for (const id of [...branchNodeIds, ...(opts.extraNodes ?? [])]) {
    subAgents.push({
      id,
      role: 'Worker ' + id,
      description: 'handles branch ' + id,
      inputs: ['routed'],
      outputs: ['result_' + id],
    });
  }
  return SystemSpecSchema.parse({
    goal: 'Route the request to the right handler.',
    sub_agents: subAgents,
    coordination: { pattern: 'fan_out_in' },
    coordination_pattern: 'router',
    ...(opts.withRouterField === false ? {} : { router: { branches } }),
    triggers: ['api'],
  });
}

// Build a valid router OrchestrationPlan (incl. branch metadata) from the
// expanded graph — used by the orchestrator-generation assertions.
function routerPlan(spec: SystemSpec): OrchestrationPlan {
  const graph = expandCoordination(spec);
  const nodes: OrchestrationNode[] = graph.nodeIds.map((id) => {
    const sub = spec.sub_agents.find((s) => s.id === id)!;
    const upstreams = graph.upstreamByNode[id] ?? [];
    const inputs =
      upstreams.length === 0
        ? [{ from: null, output: 'request' }]
        : upstreams.map((u) => ({
            from: u,
            output: spec.sub_agents.find((s) => s.id === u)?.outputs[0] ?? 'handoff',
          }));
    return { id, role: sub.role, task: 't', inputs, outputs: sub.outputs, suggested_tools: [] };
  });
  return OrchestrationPlanSchema.parse({
    goal: spec.goal,
    pattern: spec.coordination.pattern,
    max_steps: spec.max_steps,
    nodes,
    edges: graph.edges,
    execution_order: graph.executionOrder,
    warnings: [],
    branch: graph.branch,
  });
}

// ===========================================================================
// CATALOG
// ===========================================================================
describe('coordination catalog — router', () => {
  it('lists router + declares the router node role', () => {
    expect(listPatterns().map((p) => p.id)).toContain('router');
    expect(getPattern('router').node_roles).toEqual([ROUTER_ROLE]);
  });

  it('isRouterRole matches "router" case-insensitively, nothing else', () => {
    expect(isRouterRole('router')).toBe(true);
    expect(isRouterRole('  Router ')).toBe(true);
    expect(isRouterRole('controller')).toBe(false);
    expect(isRouterRole('routers')).toBe(false);
    expect(ROUTER_ROLE).toBe('router');
  });
});

// ===========================================================================
// EXPAND — acyclic router→branches DAG + branch metadata
// ===========================================================================
describe('router expand()', () => {
  it('fans the router out to each branch entry (acyclic)', () => {
    const graph = expandCoordination(routerSpec());
    expect(graph.nodeIds).toEqual(['route', 'a', 'b', 'c']);
    // Every edge is router → a branch entry.
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ['route', 'a'],
      ['route', 'b'],
      ['route', 'c'],
    ]);
    // Router runs first; acyclic.
    expect(graph.executionOrder[0]).toBe('route');
    expect(graph.executionOrder).toHaveLength(4);
    expect(graph.issues).toEqual([]);
  });

  it('attaches branch metadata (router id + key→nodeIds)', () => {
    const graph = expandCoordination(routerSpec());
    expect(graph.branch).toBeDefined();
    expect(graph.branch!.routerId).toBe('route');
    expect(graph.branch!.branches).toEqual([
      { key: 'alpha', nodeIds: ['a'] },
      { key: 'beta', nodeIds: ['b'] },
      { key: 'gamma', nodeIds: ['c'] },
    ]);
  });

  it('chains a multi-node branch as a pipeline', () => {
    const graph = expandCoordination(
      routerSpec({
        branches: [
          { key: 'alpha', node_ids: ['a', 'a2'] },
          { key: 'beta', node_ids: ['b'] },
        ],
      }),
    );
    // route → a, a → a2, route → b. Acyclic.
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ['route', 'a'],
      ['a', 'a2'],
      ['route', 'b'],
    ]);
    expect(graph.branch!.branches[0]).toEqual({ key: 'alpha', nodeIds: ['a', 'a2'] });
  });
});

// ===========================================================================
// CONSTRAINTS — typed bad_input
// ===========================================================================
describe('router constraints', () => {
  function expectBadInput(fn: () => unknown) {
    try {
      fn();
      expect.fail('expected a bad_input EngineError');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe('router_constraint');
    }
  }

  it('0 routers → bad_input (needs exactly 1)', () => {
    expectBadInput(() => expandCoordination(routerSpec({ routers: 0 })));
  });

  it('2 routers → bad_input (needs exactly 1)', () => {
    expectBadInput(() => expandCoordination(routerSpec({ routers: 2 })));
  });

  it('< 2 branches → bad_input', () => {
    expectBadInput(() =>
      expandCoordination(routerSpec({ branches: [{ key: 'alpha', node_ids: ['a'] }] })),
    );
  });

  it('duplicate branch keys → bad_input', () => {
    expectBadInput(() =>
      expandCoordination(
        routerSpec({
          branches: [
            { key: 'dup', node_ids: ['a'] },
            { key: 'dup', node_ids: ['b'] },
          ],
        }),
      ),
    );
  });

  it('missing router field → bad_input', () => {
    expectBadInput(() => expandCoordination(routerSpec({ withRouterField: false })));
  });

  it('an orphan non-router node (in no branch) → bad_input', () => {
    expectBadInput(() => expandCoordination(routerSpec({ extraNodes: ['orphan'] })));
  });

  it('a sub_agent in two branches → bad_input', () => {
    expectBadInput(() =>
      expandCoordination(
        routerSpec({
          branches: [
            { key: 'alpha', node_ids: ['a'] },
            { key: 'beta', node_ids: ['a'] },
          ],
        }),
      ),
    );
  });
});

// ===========================================================================
// GENERATED ORCHESTRATOR — conditional skip is deterministic + parses
// ===========================================================================
describe('router orchestrator generation', () => {
  it('inlines BRANCH_META + conditional skip + the no-match failure', () => {
    const spec = routerSpec();
    const plan = routerPlan(spec);
    const src = generateOrchestratorSource(spec, plan).content;
    expect(src).toContain('const BRANCH_META');
    expect(src).toContain('if (skip.has(nodeId))');
    expect(src).toContain('BRANCH_META.routerId');
    expect(src).toContain('out.branch');
    expect(src).toContain('router_no_branch_match');
  });

  it('the generated router orchestrator passes the esbuild static check', async () => {
    const spec = routerSpec();
    const plan = routerPlan(spec);
    const { path, content } = generateOrchestratorSource(spec, plan);
    const res = await staticCheckFile(path, content);
    expect(res.ok).toBe(true);
  });

  it('a NON-router plan orchestrator carries NO branch logic (byte-compatible)', () => {
    const spec = SystemSpecSchema.parse({
      goal: 'Plain pipeline.',
      sub_agents: [
        { id: 'a', role: 'A', description: 'first', inputs: [], outputs: ['x'] },
        { id: 'b', role: 'B', description: 'second', inputs: ['x'], outputs: ['y'] },
      ],
      coordination: { pattern: 'pipeline' },
      triggers: ['api'],
    });
    const plan = OrchestrationPlanSchema.parse({
      goal: spec.goal,
      pattern: 'pipeline',
      max_steps: spec.max_steps,
      nodes: [
        { id: 'a', role: 'A', task: 't', inputs: [{ from: null, output: 'in' }], outputs: ['x'], suggested_tools: [] },
        { id: 'b', role: 'B', task: 't', inputs: [{ from: 'a', output: 'x' }], outputs: ['y'], suggested_tools: [] },
      ],
      edges: [{ from: 'a', to: 'b', payload: 'x' }],
      execution_order: ['a', 'b'],
      warnings: [],
    });
    const src = generateOrchestratorSource(spec, plan).content;
    expect(src).not.toContain('BRANCH_META');
    expect(src).not.toContain('skip.has');
  });
});

// ===========================================================================
// BACKWARD COMPAT
// ===========================================================================
describe('branch metadata is additive', () => {
  it('a standard pipeline graph carries NO branch metadata', () => {
    const spec = SystemSpecSchema.parse({
      goal: 'Plain pipeline.',
      sub_agents: [
        { id: 'a', role: 'A', description: 'first', inputs: [], outputs: ['x'] },
        { id: 'b', role: 'B', description: 'second', inputs: ['x'], outputs: ['y'] },
      ],
      coordination: { pattern: 'pipeline' },
      triggers: ['api'],
    });
    expect(expandCoordination(spec).branch).toBeUndefined();
  });
});
