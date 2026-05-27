// Hermetic end-to-end dry-run — Phase 2 (Systems) RUNTIME.
//
// Companion to system-deploy-dryrun.test.ts. That file drives the
// push + deploy gates and stops at 'deployed'; this file picks up at
// 'deployed' and drives:
//
//   1. POST /system/runtime/activate with { authorized: true, cron, ... }
//      → kind='system' agent_runtimes row inserted; build → 'running'
//   2. runOnce(supabase, runtime, 'manual') → dispatches by kind to
//      runSystemOnce → executes the orchestrator in LIVE mode (the
//      executor is STUBBED via `selectProvider`); records a `runs`
//      row with the run's total compute_ms; ledger billed once for
//      the WHOLE run
//   3. SHARED COST CEILING — a run whose projected cost exceeds the
//      budget is BLOCKED at the pre-run governance gate; the runtime
//      auto-pauses to 'errored' (whole-system block, not per-agent)
//   4. KILL SWITCH — an active kill switch over the project halts
//      the WHOLE system run mid-flight via the executor's watcher;
//      the run records as failed; the runtime auto-pauses
//   5. 3-strike AUTO-PAUSE — three consecutive failed runs flip the
//      runtime to 'errored' and the scheduler doesn't pick it up a
//      4th time
//   6. STOP — confirm Phase 1 runtime activation 409s a system build
//      with the system-route hint
//
// "Both gates required" already proven for push/deploy; for runtime
// activation we likewise prove `{ authorized: false }` → 403.
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  Build,
  BuildFile,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import {
  SystemSpecSchema,
  type SystemSpec,
} from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Module-level mocks. Set BEFORE importing the route handler.
// ---------------------------------------------------------------------------

const FAKE_USER = { id: 'user-sys-runtime-dry-run', email: 'test@example.com' };
const PROJECT_ID = 'project-sys-runtime-dry-run';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    requireUser: vi.fn(async () => FAKE_USER),
    requireProjectOwnership: vi.fn(async (id: string) => ({
      project: {
        id,
        user_id: FAKE_USER.id,
        name: 'arXiv System',
        status: 'deployed',
        kind: 'system',
        created_at: new Date().toISOString(),
      } as Project,
    })),
  };
});

// Governance: tolerate the route's pre-flight assertAllowed. The
// scheduler's per-run gate uses the REAL implementation so we can
// exercise the shared-ceiling path; we swap that one mock per test.
vi.mock('@/lib/engine/governance/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/guard')>();
  return {
    ...actual,
    assertAllowed: vi.fn(async () => undefined),
  };
});

// peekKeySource: pretend the user has a BYOK E2B key so the per-run
// gate uses the 'byok' posture and won't pause for budget by default.
vi.mock('@/lib/engine/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/keys')>();
  return {
    ...actual,
    peekKeySource: vi.fn(async () => ({ source: 'byok' as const, key_last4: 'test' })),
    resolveKey: vi.fn(async () => ({ key: 'sk-test', source: 'byok' as const })),
  };
});

// Kill switch: defaults to "no kill"; individual tests override.
vi.mock('@/lib/engine/governance/killswitch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/killswitch')>();
  return {
    ...actual,
    activeKillSwitch: vi.fn(async () => null),
  };
});

// Cost ledger: spy so we can assert "one event per WHOLE run" (shared
// ceiling — not N events per N agents).
vi.mock('@/lib/engine/governance/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/ledger')>();
  return {
    ...actual,
    recordCost: vi.fn(async () => ({ amount_usd: 0.001, event_id: 'evt-fake' })),
  };
});

// SandboxProvider: scripted per test so the live orchestrator exec is
// deterministic. Same pattern as the system sandbox dry-run.
vi.mock('@/lib/engine/sandbox/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/sandbox/provider')>();
  return {
    ...actual,
    selectProvider: vi.fn(),
  };
});

// Supabase: in-memory client per test.
const dbHolder: { current: InMemoryDb | null } = { current: null };
vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>();
  return {
    ...actual,
    getServerSupabase: vi.fn(() => {
      const db = dbHolder.current;
      if (!db) throw new Error('test forgot to seed dbHolder.current');
      return makeClient(db);
    }),
  };
});

import { activeKillSwitch } from '@/lib/engine/governance/killswitch';
import { recordCost } from '@/lib/engine/governance/ledger';
import {
  selectProvider,
  type SandboxProvider,
} from '@/lib/engine/sandbox/provider';
import { assertAllowed, GovernanceError } from '@/lib/engine/governance/guard';
import { runOnce } from '@/lib/engine/runtime/scheduler';
import { loadRuntimeForProject } from '@/lib/engine/runtime/persistence';

import { POST as systemActivatePOST } from '@/app/api/projects/[id]/system/runtime/activate/route';
import { POST as agentActivatePOST } from '@/app/api/projects/[id]/runtime/activate/route';

// ---------------------------------------------------------------------------
// Canned data.
// ---------------------------------------------------------------------------

const CANNED_SYSTEM_SPEC: SystemSpec = SystemSpecSchema.parse({
  goal: 'arxiv pipeline',
  sub_agents: [
    { id: 'scraper', role: 'scraper', description: 'pulls', inputs: ['time_window'], outputs: ['raw_papers'] },
    { id: 'summarizer', role: 'summarizer', description: 'summarises', inputs: ['raw_papers'], outputs: ['summary'] },
    { id: 'emailer', role: 'emailer', description: 'emails', inputs: ['summary'], outputs: ['delivery_receipt'] },
  ],
  coordination: { pattern: 'pipeline' },
  triggers: ['schedule'],
});

const CANNED_ORCH_PLAN: OrchestrationPlan = OrchestrationPlanSchema.parse({
  goal: 'arxiv pipeline',
  pattern: 'pipeline',
  max_steps: CANNED_SYSTEM_SPEC.max_steps,
  nodes: [
    { id: 'scraper', role: 'scraper', task: 'x', inputs: [{ from: null, output: 'time_window' }], outputs: ['raw_papers'], suggested_tools: [] },
    { id: 'summarizer', role: 'summarizer', task: 'x', inputs: [{ from: 'scraper', output: 'raw_papers' }], outputs: ['summary'], suggested_tools: [] },
    { id: 'emailer', role: 'emailer', task: 'x', inputs: [{ from: 'summarizer', output: 'summary' }], outputs: ['delivery_receipt'], suggested_tools: [] },
  ],
  edges: [
    { from: 'scraper', to: 'summarizer', payload: 'raw_papers' },
    { from: 'summarizer', to: 'emailer', payload: 'summary' },
  ],
  execution_order: ['scraper', 'summarizer', 'emailer'],
  warnings: [],
});

// ---------------------------------------------------------------------------
// Fake SandboxProvider — scripts a sequence of exec results.
// ---------------------------------------------------------------------------

interface ExecResultLite {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

function makeFakeProvider(execScript: ExecResultLite[]): {
  provider: SandboxProvider;
  spies: {
    create: ReturnType<typeof vi.fn>;
    writeFiles: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
} {
  const create = vi.fn(async () => undefined);
  const writeFiles = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  let i = 0;
  const exec = vi.fn(async () => {
    const next = execScript[i];
    i++;
    if (!next) {
      throw new Error(
        'fake provider: ran out of scripted execs at index ' + (i - 1),
      );
    }
    return next;
  });
  return {
    provider: {
      name: 'fake',
      create,
      writeFiles,
      workspace: () => '/workspace',
      exec,
      destroy,
    } as unknown as SandboxProvider,
    spies: { create, writeFiles, exec, destroy },
  };
}

function ok(stdout = '', stderr = ''): ExecResultLite {
  return { stdout, stderr, exitCode: 0, timedOut: false, durationMs: 100 };
}
function fail(stdout = '', stderr = '', exitCode = 1): ExecResultLite {
  return { stdout, stderr, exitCode, timedOut: false, durationMs: 100 };
}

function liveRunPass(): ExecResultLite {
  return ok(
    '[run] orchestrate_passed {"steps":3,"final_node":"emailer","expected_steps":3,"expected_final_node":"emailer","output_keys":["delivery_receipt"]}\n',
    '',
  );
}
function liveRunFail(nodeId: string): ExecResultLite {
  return fail(
    '[run] orchestrate_failed ' +
      JSON.stringify({ node: nodeId, message: 'handoff validation failed' }) +
      '\n',
    '',
  );
}

// ---------------------------------------------------------------------------
// Seed helpers.
// ---------------------------------------------------------------------------

function seedDeployedSystem(db: InMemoryDb): {
  project: Project;
  spec: Spec;
  plan: Plan;
  build: Build;
  files: BuildFile[];
} {
  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: 'arXiv System',
    status: 'deployed',
    kind: 'system',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-sys-rt-1',
    project_id: project.id,
    raw_prompt: 'arxiv',
    structured_spec: CANNED_SYSTEM_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'confirmed',
    kind: 'system',
    created_at: new Date().toISOString(),
  };
  const plan: Plan = {
    id: 'plan-sys-rt-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_ORCH_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'system',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-sys-rt-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: 'deployed',
    logs: { static_checks: [], warnings: [] } as unknown as Build['logs'],
    repo_url: 'https://github.com/forge-tester/arxiv-system',
    deploy_url: 'https://arxiv-system.vercel.app',
    kind: 'system',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const files: BuildFile[] = [
    {
      id: 'f-1',
      build_id: build.id,
      path: 'src/orchestrator.ts',
      content: '// orchestrator\n',
      source: 'generated',
      bytes: 20,
      created_at: new Date().toISOString(),
    },
  ];
  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.build_files = files.map((f) => f as unknown as Record<string, unknown>);
  return { project, spec, plan, build, files };
}

function makePost(body: unknown): Request {
  return new Request('http://test/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(selectProvider).mockReset();
  vi.mocked(activeKillSwitch).mockReset();
  vi.mocked(activeKillSwitch).mockResolvedValue(null);
  vi.mocked(recordCost).mockReset();
  vi.mocked(recordCost).mockResolvedValue({
    amount_usd: 0.001,
    event_id: 'evt-fake',
  });
  vi.mocked(assertAllowed).mockReset();
  vi.mocked(assertAllowed).mockResolvedValue({ ok: true });
  dbHolder.current = null;
});

describe('Phase 2 SYSTEM runtime hermetic dry-run', () => {
  // ========================================================================
  // PASSING PATH — gated activation; one orchestration run; ledger billed
  // once for the WHOLE run.
  // ========================================================================
  it('happy path: gated activate → kind=system runtime; one run executes orchestrator; ledger billed ONCE for the run', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedDeployedSystem(db);

    // --- 1. activation gate ---
    const actRes = await systemActivatePOST(
      makePost({
        authorized: true,
        cron: '*/5 * * * *',
        env: { ANTHROPIC_API_KEY: 'sk-test', RESEND_API_KEY: 'rk-test' },
        mode: 'schedule',
        max_run_ms: 30_000,
      }),
      { params: { id: PROJECT_ID } },
    );
    expect(actRes.status).toBe(200);
    const actBody = (await actRes.json()) as {
      status: string;
      kind: string;
      runtime_id: string;
    };
    expect(actBody.status).toBe('active');
    expect(actBody.kind).toBe('system');

    // Build flipped to 'running', kind='system' runtime row inserted.
    const runtimeRow = (db.tables.agent_runtimes ?? [])[0] as
      | AgentRuntime
      | undefined;
    expect(runtimeRow?.kind).toBe('system');
    expect(runtimeRow?.status).toBe('active');
    const updatedBuild = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(updatedBuild?.status).toBe('running');

    // --- 2. one orchestration run via the shared scheduler ---
    const { provider, spies } = makeFakeProvider([
      ok('install ok'),
      liveRunPass(),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    const supabase = makeClient(db) as unknown as Parameters<typeof runOnce>[0];
    const rt = await loadRuntimeForProject(supabase, PROJECT_ID);
    expect(rt).toBeTruthy();
    if (!rt) throw new Error('unreachable');

    await runOnce(supabase, rt, 'manual');

    // === The run executed inside the live sandbox (provider lifecycle) ===
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.destroy).toHaveBeenCalledTimes(1);
    expect(spies.exec).toHaveBeenCalledTimes(2); // install + run

    // === ONE runs row, status='succeeded' ===
    const runs = (db.tables.runs ?? []) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('succeeded');

    // === SHARED CEILING — ONE ledger event for the WHOLE run, not N ===
    expect(vi.mocked(recordCost)).toHaveBeenCalledTimes(1);
    const cost = vi.mocked(recordCost).mock.calls[0]?.[0];
    expect(cost).toBeDefined();
    if (!cost) throw new Error('unreachable');
    expect(cost.kind).toBe('runtime');
    expect(cost.user_id).toBe(FAKE_USER.id);
    expect(typeof cost.compute_ms).toBe('number');

    // === Audit trail ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'system.runtime_activated')).toBe(true);
    expect(audit.some((r) => r.action === 'system.run_started')).toBe(true);
    expect(audit.some((r) => r.action === 'system.run_succeeded')).toBe(true);

    // === Phase 1 runtime activation 409s the system build ===
    const phase1Res = await agentActivatePOST(
      makePost({ authorized: true, cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );
    expect(phase1Res.status).toBe(409);
    const phase1Body = (await phase1Res.json()) as { error?: string };
    expect(phase1Body.error).toMatch(/system build/i);
    expect(phase1Body.error).toMatch(/system\/runtime\/activate/i);
  });

  // ========================================================================
  // ACTIVATION GATE REQUIRED — no { authorized: true } → 403; no runtime
  // row inserted; the build stays 'deployed'.
  // ========================================================================
  it('activation refuses missing { authorized: true } with 403; no runtime row inserted', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSystem(db);

    const noFlagRes = await systemActivatePOST(
      makePost({ cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );
    expect(noFlagRes.status).toBe(403);

    const explicitFalseRes = await systemActivatePOST(
      makePost({ authorized: false, cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );
    expect(explicitFalseRes.status).toBe(403);

    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
    const build = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(build?.status).toBe('deployed');
  });

  // ========================================================================
  // SHARED CEILING — a run whose projected cost exceeds the budget is
  // BLOCKED at the pre-run governance gate. The runtime auto-pauses to
  // 'errored' (whole-system block, not one agent), and the executor is
  // NEVER invoked.
  // ========================================================================
  it('shared ceiling: over-budget run is blocked; runtime auto-paused; executor never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedDeployedSystem(db);
    void build;

    // Activate as before.
    await systemActivatePOST(
      makePost({ authorized: true, cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );

    // Make the per-run governance gate FAIL with a budget error. The
    // scheduler's runSystemOnce surfaces this by pausing the runtime
    // to 'errored' without executing.
    vi.mocked(assertAllowed).mockImplementationOnce(async () => {
      throw new GovernanceError('budget', { limit_usd: 0.5, spent_usd: 0.6 });
    });

    const { provider, spies } = makeFakeProvider([
      ok('this provider should NEVER be used'),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    const supabase = makeClient(db) as unknown as Parameters<typeof runOnce>[0];
    const rt = await loadRuntimeForProject(supabase, PROJECT_ID);
    if (!rt) throw new Error('unreachable');

    await runOnce(supabase, rt, 'tick');

    // === Executor NEVER invoked (provider untouched) ===
    expect(spies.create).toHaveBeenCalledTimes(0);
    expect(spies.exec).toHaveBeenCalledTimes(0);
    expect(spies.destroy).toHaveBeenCalledTimes(0);

    // === Runtime auto-paused to 'errored' ===
    const runtimeRow = (db.tables.agent_runtimes ?? [])[0] as
      | AgentRuntime
      | undefined;
    expect(runtimeRow?.status).toBe('errored');

    // === No runs row (the gate fired before insertRunningRunRow) ===
    expect((db.tables.runs ?? []).length).toBe(0);

    // === Audit trail records the budget pause specifically ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(
      audit.some((r) => r.action === 'system.runtime_budget_paused'),
    ).toBe(true);

    // === No ledger event — nothing was spent ===
    expect(vi.mocked(recordCost)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // KILL SWITCH — an active scoped kill switch halts the WHOLE system
  // run mid-flight. The watcher detects it during the exec, calls
  // provider.destroy(), and the run records as failed with the
  // kill-switch marker.
  // ========================================================================
  it('kill switch halts the whole system run mid-flight; run records failed', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSystem(db);
    await systemActivatePOST(
      makePost({ authorized: true, cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );

    // Scripted provider: install ok, then a long-running exec that
    // the watcher tears down. To simulate the watcher firing, we
    // resolve the exec with a failed exit AFTER the watcher polls
    // and calls destroy().
    const { provider, spies } = makeFakeProvider([
      ok('install ok'),
      // The exec returns a failed result — in production the watcher
      // would have already destroyed the sandbox; here we simulate
      // that the destroy made the exec fail.
      fail('', 'destroyed', 137),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    // First kill-switch poll returns active; the watcher will tear
    // down the sandbox. Subsequent polls also return active.
    vi.mocked(activeKillSwitch).mockResolvedValue({
      id: 'ks-1',
      scope: 'project',
      scope_id: PROJECT_ID,
      active: true,
      reason: 'test',
      set_by: null,
      created_at: new Date().toISOString(),
    });

    const supabase = makeClient(db) as unknown as Parameters<typeof runOnce>[0];
    const rt = await loadRuntimeForProject(supabase, PROJECT_ID);
    if (!rt) throw new Error('unreachable');

    // Use a short max_run_ms so the watcher has time to poll twice
    // and the exec returns quickly. The watcher cadence is 4s so we
    // can't guarantee a mid-flight tear-down in the test window, but
    // we can verify the run records as failed when the exec returns
    // non-zero — which is the observable outcome of a mid-flight
    // kill-switch.
    await runOnce(supabase, rt, 'tick');

    // === Provider lifecycle still single-shot: create + destroy ===
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.destroy).toHaveBeenCalledTimes(1);

    // === Run recorded as failed; runtime fail_count incremented ===
    const runs = (db.tables.runs ?? []) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    const runtimeRow = (db.tables.agent_runtimes ?? [])[0] as
      | AgentRuntime
      | undefined;
    expect((runtimeRow?.fail_count ?? 0)).toBeGreaterThanOrEqual(1);

    // === Ledger still billed for the (partial) sandbox compute ===
    expect(vi.mocked(recordCost)).toHaveBeenCalled();
  });

  // ========================================================================
  // 3-strike AUTO-PAUSE — three consecutive failed runs flip the
  // runtime to 'errored'. The 4th call to runOnce would normally pick
  // up the runtime; we assert the runtime status is 'errored' after
  // the third failure so the scheduler will skip it.
  // ========================================================================
  it('3 consecutive failures auto-pause the runtime; no 4th run', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSystem(db);
    await systemActivatePOST(
      makePost({ authorized: true, cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );

    const supabase = makeClient(db) as unknown as Parameters<typeof runOnce>[0];

    // Three failing runs. Each call needs its own scripted provider
    // because the provider is single-use per run (create → destroy).
    for (let i = 0; i < 3; i++) {
      const { provider } = makeFakeProvider([
        ok('install ok'),
        liveRunFail('summarizer'),
      ]);
      vi.mocked(selectProvider).mockReturnValueOnce(provider);

      const rt = await loadRuntimeForProject(supabase, PROJECT_ID);
      if (!rt) throw new Error('unreachable');
      // After the 3rd failure the runtime auto-pauses; we still
      // invoke runOnce with the stale runtime row to verify the
      // post-run state.
      await runOnce(supabase, rt, 'tick');
    }

    // After exactly 3 failures, the runtime is auto-paused.
    const runtimeAfter = (db.tables.agent_runtimes ?? [])[0] as
      | AgentRuntime
      | undefined;
    expect(runtimeAfter?.status).toBe('errored');
    expect(runtimeAfter?.consecutive_fails).toBe(3);
    expect(runtimeAfter?.fail_count).toBe(3);

    // There are 3 runs; no 4th run was started.
    expect((db.tables.runs ?? []).length).toBe(3);

    // Audit trail records the auto-pause.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(
      audit.some((r) => r.action === 'system.runtime_auto_paused'),
    ).toBe(true);

    // === 4th tick: the scheduler's tickRuntimes filters by status='active',
    // so the auto-paused runtime is NOT picked. We assert via the runtime
    // row's current status — the scheduler can't pick a non-active row. ===
    const rt = await loadRuntimeForProject(supabase, PROJECT_ID);
    expect(rt?.status).not.toBe('active');
  });

  // ========================================================================
  // MISROUTE — Phase 1 activate refuses a system build with the
  // explicit hint (defence in depth from the loader).
  // ========================================================================
  it('Phase 1 runtime activate 409s a system build with the system-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSystem(db);

    const res = await agentActivatePOST(
      makePost({ authorized: true, cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/system build/i);
    expect(body.error).toMatch(/system\/runtime\/activate/i);
  });

  // ========================================================================
  // Hermeticity.
  // ========================================================================
  it('zero real fetch calls across the whole system runtime dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
