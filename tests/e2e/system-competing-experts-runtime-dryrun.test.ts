// Hermetic — a competing_experts run is ONE governed unit: all N+1
// nodes (experts + judge) run under a SINGLE shared cost ceiling
// (one assertAllowed, one recordCost), exactly like a standard system.
// The executor is mocked (no sandbox); we assert the scheduler's
// per-run governance + ledger shape is unchanged by the larger node set.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  Build,
  BuildFile,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
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
// Executor: mocked so no sandbox is touched. Captures the plan it sees.
const executorCalls: OrchestrationPlan[] = [];
vi.mock('@/lib/engine/system/runtime/executor', () => ({
  executeSystemRun: vi.fn(async (input: { plan: OrchestrationPlan }) => {
    executorCalls.push(input.plan);
    return {
      success: true,
      output: { steps: input.plan.nodes.length, final_node: 'judge', output_keys: ['best'] },
      handoff_failure: null,
      logs: [],
      error: null,
      duration_ms: 1234,
      provider: 'fake',
      key_source: 'byok' as const,
      killed_by_kill_switch: false,
      steps_completed: input.plan.nodes.length,
    };
  }),
}));

import { runSystemOnce } from '@/lib/engine/system/runtime/scheduler';
import { assertAllowed } from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';

const assertAllowedMock = assertAllowed as unknown as ReturnType<typeof vi.fn>;
const recordCostMock = recordCost as unknown as ReturnType<typeof vi.fn>;

const USER_ID = 'user-ce-runtime';
const PROJECT_ID = 'project-ce-runtime';

function ceSpec(): SystemSpec {
  return SystemSpecSchema.parse({
    goal: 'Best summary wins.',
    sub_agents: [
      { id: 'expert_a', role: 'Expert A', description: 'a', inputs: ['text'], outputs: ['candidate_a'] },
      { id: 'expert_b', role: 'Expert B', description: 'b', inputs: ['text'], outputs: ['candidate_b'] },
      { id: 'expert_c', role: 'Expert C', description: 'c', inputs: ['text'], outputs: ['candidate_c'] },
      { id: 'judge', role: 'judge', description: 'judge', inputs: ['candidates'], outputs: ['best'] },
    ],
    coordination: { pattern: 'fan_out_in' },
    coordination_pattern: 'competing_experts',
    triggers: ['schedule'],
  });
}

function cePlan(spec: SystemSpec): OrchestrationPlan {
  const graph = expandCoordination(spec);
  const nodes: OrchestrationNode[] = graph.nodeIds.map((id) => {
    const sub = spec.sub_agents.find((s) => s.id === id)!;
    const upstreams = graph.upstreamByNode[id] ?? [];
    const inputs =
      upstreams.length === 0
        ? [{ from: null, output: 'text' }]
        : upstreams.map((u) => ({
            from: u,
            output: spec.sub_agents.find((s) => s.id === u)?.outputs[0] ?? 'candidate',
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
  });
}

function seed(db: InMemoryDb, spec: SystemSpec, plan: OrchestrationPlan): AgentRuntime {
  db.tables.projects = [
    {
      id: PROJECT_ID,
      user_id: USER_ID,
      name: 'CE System',
      status: 'deployed',
      kind: 'system',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.specs = [
    {
      id: 'spec-ce',
      project_id: PROJECT_ID,
      raw_prompt: 'ce',
      structured_spec: spec as unknown,
      open_questions: [],
      feedback: null,
      status: 'confirmed',
      kind: 'system',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.plans = [
    {
      id: 'plan-ce',
      project_id: PROJECT_ID,
      spec_id: 'spec-ce',
      plan: plan as unknown,
      status: 'approved',
      kind: 'system',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.builds = [
    {
      id: 'build-ce',
      project_id: PROJECT_ID,
      spec_id: 'spec-ce',
      plan_id: 'plan-ce',
      status: 'running',
      kind: 'system',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.build_files = [
    {
      id: 'bf-ce',
      build_id: 'build-ce',
      path: 'src/orchestrator.ts',
      content: 'export const x = 1;',
      source: 'generated',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.runs = [];
  db.tables.audit_log = [];
  const runtime: AgentRuntime = {
    id: 'runtime-ce',
    project_id: PROJECT_ID,
    build_id: 'build-ce',
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

describe('competing_experts runtime — single shared cost ceiling', () => {
  it('a 4-node (3 experts + judge) run does ONE assertAllowed + ONE recordCost', async () => {
    const spec = ceSpec();
    const plan = cePlan(spec);
    // Sanity: the plan really is N+1 = 4 nodes.
    expect(plan.nodes).toHaveLength(4);

    const db = createInMemoryDb();
    const runtime = seed(db, spec, plan);
    const supabase = makeClient(db) as unknown as Parameters<typeof runSystemOnce>[0];

    await runSystemOnce(supabase, runtime, 'manual');

    // ONE governed unit for the WHOLE run — not one per node.
    expect(assertAllowedMock).toHaveBeenCalledTimes(1);
    expect(recordCostMock).toHaveBeenCalledTimes(1);

    // The single ledger event is a 'runtime' event spanning the whole run.
    const costArgs = recordCostMock.mock.calls[0]![0] as { kind: string };
    expect(costArgs.kind).toBe('runtime');

    // The executor ran the ONE orchestrator over all 4 nodes.
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]!.nodes).toHaveLength(4);

    // run_started audit recorded the full node count.
    const audits = (db.tables.audit_log ?? []) as Array<{
      action: string;
      detail: Record<string, unknown>;
    }>;
    const started = audits.find((a) => a.action === 'system.run_started');
    expect(started?.detail.nodes).toBe(4);
  });
});
