// Hermetic — a loop_with_break run is N governed units (one per
// iteration), NOT one. The scheduler drives the bounded loop: each
// iteration runs the body+controller plan ONCE via executeSystemRun under
// its OWN assertAllowed + kill-switch check, and records ONE ledger event
// (ref '….iteration.N'). The executor is mocked (no sandbox); we assert
// the per-iteration governance + ledger + the bounded-loop semantics
// (max-iterations cap, controller break, mid-loop kill, mid-loop budget).

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
import { GovernanceError } from '@/lib/engine/governance/guard';

const USER_ID = 'user-loop-runtime';
const PROJECT_ID = 'project-loop-runtime';

// Governance + ledger: spies so we can assert "one per ITERATION".
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
// Kill switch: a mutable flag the executor mock can flip MID-LOOP, so the
// next iteration's pre-iteration check trips. activeKillSwitch is fully
// mocked off this flag (no DB row needed).
let killActive = false;
vi.mock('@/lib/engine/governance/killswitch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/killswitch')>();
  return {
    ...actual,
    activeKillSwitch: vi.fn(async () =>
      killActive
        ? {
            id: 'k',
            scope: 'project',
            scope_id: PROJECT_ID,
            active: true,
            reason: 'test',
            set_by: 't',
            created_at: new Date().toISOString(),
          }
        : null,
    ),
  };
});

// Executor: mocked so no sandbox is touched. Captures the externalInput +
// loop wiring per call; returns a controllable decision; can flip the kill
// flag after a given call count.
interface ExecCall {
  externalInput: Record<string, unknown> | undefined;
  loop: { controllerId: string; backEdgeFrom: string } | undefined;
}
const executorCalls: ExecCall[] = [];
let decisionForCall: (callIndex0: number) => 'continue' | 'break' = () => 'continue';
let flipKillAfterCall = Number.POSITIVE_INFINITY;

vi.mock('@/lib/engine/system/runtime/executor', () => ({
  executeSystemRun: vi.fn(
    async (input: {
      plan: OrchestrationPlan;
      externalInput?: Record<string, unknown>;
      loop?: { controllerId: string; backEdgeFrom: string };
    }) => {
      const idx = executorCalls.length; // 0-based
      executorCalls.push({ externalInput: input.externalInput, loop: input.loop });
      const callNum = idx + 1; // 1-based
      if (callNum >= flipKillAfterCall) killActive = true;
      const decision = decisionForCall(idx);
      return {
        success: true,
        output: {
          steps: input.plan.nodes.length,
          final_node: 'controller',
          output_keys: ['decision'],
          decision,
          decision_reason: decision === 'break' ? 'good enough' : null,
          final_output: { draft: 'd' + idx },
        },
        handoff_failure: null,
        logs: [],
        error: null,
        duration_ms: 100,
        provider: 'fake',
        key_source: 'byok' as const,
        killed_by_kill_switch: false,
        steps_completed: input.plan.nodes.length,
      };
    },
  ),
}));

import { runSystemOnce } from '@/lib/engine/system/runtime/scheduler';
import { assertAllowed } from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';

const assertAllowedMock = assertAllowed as unknown as ReturnType<typeof vi.fn>;
const recordCostMock = recordCost as unknown as ReturnType<typeof vi.fn>;

function loopSpec(maxIterations: number): SystemSpec {
  return SystemSpecSchema.parse({
    goal: 'Refine until good enough.',
    sub_agents: [
      { id: 'body_0', role: 'Drafter', description: 'drafts', inputs: ['task'], outputs: ['draft'] },
      { id: 'body_1', role: 'Editor', description: 'edits', inputs: ['draft'], outputs: ['edited'] },
      { id: 'controller', role: 'controller', description: 'decides', inputs: ['edited'], outputs: ['decision'] },
    ],
    coordination: { pattern: 'pipeline' },
    coordination_pattern: 'loop_with_break',
    loop: { max_iterations: maxIterations, break_condition: 'good enough' },
    triggers: ['schedule'],
  });
}

function loopPlan(spec: SystemSpec): OrchestrationPlan {
  const graph = expandCoordination(spec);
  const nodes: OrchestrationNode[] = graph.nodeIds.map((id) => {
    const sub = spec.sub_agents.find((s) => s.id === id)!;
    const upstreams = graph.upstreamByNode[id] ?? [];
    const inputs =
      upstreams.length === 0
        ? [{ from: null, output: 'task' }]
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
    loop: graph.loop,
  });
}

function seed(db: InMemoryDb, spec: SystemSpec, plan: OrchestrationPlan): AgentRuntime {
  db.tables.projects = [
    {
      id: PROJECT_ID,
      user_id: USER_ID,
      name: 'Loop System',
      status: 'deployed',
      kind: 'system',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.specs = [
    {
      id: 'spec-loop',
      project_id: PROJECT_ID,
      raw_prompt: 'loop',
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
      id: 'plan-loop',
      project_id: PROJECT_ID,
      spec_id: 'spec-loop',
      plan: plan as unknown,
      status: 'approved',
      kind: 'system',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.builds = [
    {
      id: 'build-loop',
      project_id: PROJECT_ID,
      spec_id: 'spec-loop',
      plan_id: 'plan-loop',
      status: 'running',
      kind: 'system',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.build_files = [
    {
      id: 'bf-loop',
      build_id: 'build-loop',
      path: 'src/orchestrator.ts',
      content: 'export const x = 1;',
      source: 'generated',
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
  db.tables.runs = [];
  db.tables.audit_log = [];
  const runtime: AgentRuntime = {
    id: 'runtime-loop',
    project_id: PROJECT_ID,
    build_id: 'build-loop',
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

function audits(db: InMemoryDb) {
  return (db.tables.audit_log ?? []) as Array<{
    action: string;
    detail: Record<string, unknown>;
  }>;
}

beforeEach(() => {
  executorCalls.length = 0;
  killActive = false;
  decisionForCall = () => 'continue';
  flipKillAfterCall = Number.POSITIVE_INFINITY;
  assertAllowedMock.mockReset();
  assertAllowedMock.mockImplementation(async () => undefined);
  recordCostMock.mockClear();
});

describe('loop_with_break runtime — bounded by COUNT', () => {
  it('a never-breaking loop runs EXACTLY max_iterations, each its own governed unit', async () => {
    const spec = loopSpec(3);
    const plan = loopPlan(spec);
    const db = createInMemoryDb();
    const runtime = seed(db, spec, plan);
    const supabase = makeClient(db) as unknown as Parameters<typeof runSystemOnce>[0];

    await runSystemOnce(supabase, runtime, 'manual');

    // ONE executeSystemRun PER iteration — capped at max_iterations.
    expect(executorCalls).toHaveLength(3);
    // Per-iteration governance: one assertAllowed + one recordCost each.
    expect(assertAllowedMock).toHaveBeenCalledTimes(3);
    expect(recordCostMock).toHaveBeenCalledTimes(3);

    // Each ledger event is a 'runtime' event with a '.iteration.N' ref.
    const refs = recordCostMock.mock.calls.map(
      (c) => (c[0] as { kind: string; ref: string }).ref,
    );
    for (const c of recordCostMock.mock.calls) {
      expect((c[0] as { kind: string }).kind).toBe('runtime');
    }
    expect(refs.some((r) => r.endsWith('.iteration.1'))).toBe(true);
    expect(refs.some((r) => r.endsWith('.iteration.2'))).toBe(true);
    expect(refs.some((r) => r.endsWith('.iteration.3'))).toBe(true);

    // The executor saw the loop wiring + the threaded body output.
    expect(executorCalls[0]!.loop).toEqual({
      controllerId: 'controller',
      backEdgeFrom: 'body_1',
    });
    // Iteration 1 gets the synthetic base; iteration 2 gets the PREVIOUS
    // iteration's body output threaded in (back edge).
    expect(executorCalls[1]!.externalInput).toMatchObject({ draft: 'd0' });

    // ONE run lifecycle for the whole loop.
    const started = audits(db).find((a) => a.action === 'system.run_started');
    expect(started?.detail.loop).toBe(true);
    expect(started?.detail.max_iterations).toBe(3);
    expect(started?.detail.nodes).toBe(3);
    const finished = audits(db).find((a) => a.action === 'system.run_succeeded');
    expect(finished?.detail.iterations_run).toBe(3);
    expect(finished?.detail.halted_by).toBe('max_iterations');
  });
});

describe('loop_with_break runtime — break', () => {
  it('a controller break after k iterations bills exactly k', async () => {
    decisionForCall = (idx) => (idx === 1 ? 'break' : 'continue'); // 2nd call breaks
    const spec = loopSpec(5);
    const plan = loopPlan(spec);
    const db = createInMemoryDb();
    const runtime = seed(db, spec, plan);
    const supabase = makeClient(db) as unknown as Parameters<typeof runSystemOnce>[0];

    await runSystemOnce(supabase, runtime, 'manual');

    expect(executorCalls).toHaveLength(2);
    expect(recordCostMock).toHaveBeenCalledTimes(2); // early break → only k billed
    const finished = audits(db).find((a) => a.action === 'system.run_succeeded');
    expect(finished?.detail.iterations_run).toBe(2);
    expect(finished?.detail.halted_by).toBe('break');
  });
});

describe('loop_with_break runtime — per-iteration GOVERNANCE', () => {
  it('a budget exhausted mid-loop halts before the next body exec', async () => {
    // assertAllowed passes twice, then blocks the 3rd iteration.
    let calls = 0;
    assertAllowedMock.mockImplementation(async () => {
      calls += 1;
      if (calls >= 3) {
        throw new GovernanceError('budget', {
          period: 'daily',
          limit_usd: 5,
          current_usd: 5,
        });
      }
    });
    const spec = loopSpec(5);
    const plan = loopPlan(spec);
    const db = createInMemoryDb();
    const runtime = seed(db, spec, plan);
    const supabase = makeClient(db) as unknown as Parameters<typeof runSystemOnce>[0];

    await runSystemOnce(supabase, runtime, 'manual');

    expect(executorCalls).toHaveLength(2); // 3rd iteration blocked before exec
    expect(recordCostMock).toHaveBeenCalledTimes(2); // only the 2 that ran
    const finished = audits(db).find((a) => a.action === 'system.run_failed');
    expect(finished?.detail.halted_by).toBe('budget');
  });

  it('a kill switch flipped mid-loop halts after the current iteration', async () => {
    flipKillAfterCall = 2; // after the 2nd body exec, the kill switch is active
    const spec = loopSpec(5);
    const plan = loopPlan(spec);
    const db = createInMemoryDb();
    const runtime = seed(db, spec, plan);
    const supabase = makeClient(db) as unknown as Parameters<typeof runSystemOnce>[0];

    await runSystemOnce(supabase, runtime, 'manual');

    expect(executorCalls).toHaveLength(2); // no 3rd body execution
    expect(recordCostMock).toHaveBeenCalledTimes(2);
    const finished = audits(db).find((a) => a.action === 'system.run_failed');
    expect(finished?.detail.halted_by).toBe('kill_switch');
    expect(finished?.detail.killed_by_kill_switch).toBe(true);
  });
});
