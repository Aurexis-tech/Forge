// Hermetic — a router run is ONE governed unit. The conditional skip lives
// entirely inside the (deterministic) orchestrator; a router plan carries
// NO loop metadata, so the scheduler takes the SAME single-run path as a
// standard / competing_experts system: ONE assertAllowed + ONE recordCost
// for the WHOLE run (NOT loop's per-iteration model). The executor is
// mocked (no sandbox); we assert the scheduler's per-run governance shape.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@/lib/types';
import { SystemSpecSchema, type SystemSpec } from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationNode,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';
import { expandCoordination } from '@/lib/engine/system/coordination';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// Governance + ledger: spies so we can assert "one per WHOLE run".
vi.mock('@/lib/engine/governance/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/guard')>();
  return { ...actual, assertAllowed: vi.fn(async () => undefined) };
});
vi.mock('@/lib/engine/governance/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/ledger')>();
  return {
    ...actual,
    recordCost: vi.fn(async () => ({ amount_usd: 0.001, event_id: 'evt-fake' })),
  };
});
vi.mock('@/lib/engine/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/keys')>();
  return {
    ...actual,
    peekKeySource: vi.fn(async () => ({ source: 'byok' as const, key_last4: 'test' })),
  };
});
// Executor mocked — captures the plan it sees. The orchestrator (which does
// the conditional skip) runs inside the sandbox the executor would create;
// here we only assert the scheduler's per-RUN governance.
const executorCalls: OrchestrationPlan[] = [];
vi.mock('@/lib/engine/system/runtime/executor', () => ({
  executeSystemRun: vi.fn(async (input: { plan: OrchestrationPlan }) => {
    executorCalls.push(input.plan);
    return {
      success: true,
      output: { steps: 2, final_node: 'billing', output_keys: ['reply'] },
      handoff_failure: null,
      logs: [],
      error: null,
      duration_ms: 900,
      provider: 'fake',
      key_source: 'byok' as const,
      killed_by_kill_switch: false,
      steps_completed: 2,
    };
  }),
}));

import { runSystemOnce } from '@/lib/engine/system/runtime/scheduler';
import { assertAllowed } from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';

const assertAllowedMock = assertAllowed as unknown as ReturnType<typeof vi.fn>;
const recordCostMock = recordCost as unknown as ReturnType<typeof vi.fn>;

const USER_ID = 'user-router-runtime';
const PROJECT_ID = 'project-router-runtime';

function routerSpec(): SystemSpec {
  return SystemSpecSchema.parse({
    goal: 'Route the request.',
    sub_agents: [
      { id: 'route', role: 'router', description: 'routes', inputs: ['request'], outputs: ['routed'] },
      { id: 'billing', role: 'Billing', description: 'billing', inputs: ['routed'], outputs: ['reply'] },
      { id: 'tech', role: 'Tech', description: 'tech', inputs: ['routed'], outputs: ['reply'] },
    ],
    coordination: { pattern: 'fan_out_in' },
    coordination_pattern: 'router',
    router: {
      branches: [
        { key: 'billing', node_ids: ['billing'] },
        { key: 'technical', node_ids: ['tech'] },
      ],
    },
    triggers: ['schedule'],
  });
}

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

function seed(db: InMemoryDb, spec: SystemSpec, plan: OrchestrationPlan): AgentRuntime {
  db.tables.projects = [
    { id: PROJECT_ID, user_id: USER_ID, name: 'Router System', status: 'deployed', kind: 'system', created_at: new Date().toISOString() } as unknown as Record<string, unknown>,
  ];
  db.tables.specs = [
    { id: 'spec-router', project_id: PROJECT_ID, raw_prompt: 'r', structured_spec: spec as unknown, open_questions: [], feedback: null, status: 'confirmed', kind: 'system', created_at: new Date().toISOString() } as unknown as Record<string, unknown>,
  ];
  db.tables.plans = [
    { id: 'plan-router', project_id: PROJECT_ID, spec_id: 'spec-router', plan: plan as unknown, status: 'approved', kind: 'system', created_at: new Date().toISOString() } as unknown as Record<string, unknown>,
  ];
  db.tables.builds = [
    { id: 'build-router', project_id: PROJECT_ID, spec_id: 'spec-router', plan_id: 'plan-router', status: 'running', kind: 'system', created_at: new Date().toISOString() } as unknown as Record<string, unknown>,
  ];
  db.tables.build_files = [
    { id: 'bf-router', build_id: 'build-router', path: 'src/orchestrator.ts', content: 'export const x = 1;', source: 'generated', created_at: new Date().toISOString() } as unknown as Record<string, unknown>,
  ];
  db.tables.runs = [];
  db.tables.audit_log = [];
  const runtime: AgentRuntime = {
    id: 'runtime-router',
    project_id: PROJECT_ID,
    build_id: 'build-router',
    mode: 'schedule',
    schedule_cron: '0 8 * * *',
    status: 'active',
    next_run_at: null,
    last_run_at: null,
    run_count: 0,
    fail_count: 0,
    consecutive_fails: 0,
    env_keys: [],
    env_encrypted: null,
    max_run_ms: 60_000,
    kind: 'system',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  db.tables.agent_runtimes = [runtime as unknown as Record<string, unknown>];
  return runtime;
}

beforeEach(() => {
  executorCalls.length = 0;
  assertAllowedMock.mockClear();
  recordCostMock.mockClear();
});

describe('router runtime — single shared cost ceiling (NOT per-iteration)', () => {
  it('a router run does ONE assertAllowed + ONE recordCost for the whole run', async () => {
    const spec = routerSpec();
    const plan = routerPlan(spec);
    // Sanity: the plan carries branch metadata but NO loop metadata.
    expect(plan.branch).toBeDefined();
    expect(plan.loop).toBeUndefined();

    const db = createInMemoryDb();
    const runtime = seed(db, spec, plan);
    const supabase = makeClient(db) as unknown as Parameters<typeof runSystemOnce>[0];

    await runSystemOnce(supabase, runtime, 'manual');

    // ONE governed unit for the WHOLE run — the single-run model, NOT the
    // loop's per-iteration model.
    expect(assertAllowedMock).toHaveBeenCalledTimes(1);
    expect(recordCostMock).toHaveBeenCalledTimes(1);
    const costArgs = recordCostMock.mock.calls[0]![0] as { kind: string; ref: string };
    expect(costArgs.kind).toBe('runtime');
    expect(costArgs.ref).not.toContain('.iteration.');

    // The executor ran the ONE orchestrator over the full router plan; the
    // skip happens inside it.
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]!.branch?.routerId).toBe('route');

    // run_started audit recorded the full node count (router + branches).
    const audits = (db.tables.audit_log ?? []) as Array<{
      action: string;
      detail: Record<string, unknown>;
    }>;
    const started = audits.find((a) => a.action === 'system.run_started');
    expect(started?.detail.nodes).toBe(3);
  });
});
