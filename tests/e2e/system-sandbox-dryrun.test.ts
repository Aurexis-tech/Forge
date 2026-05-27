// Hermetic end-to-end dry-run — Phase 2 (Systems) SANDBOX.
//
// Companion to system-codegen-dryrun.test.ts. That file drives the
// codegen side and stops at 'generated'; this file picks up at
// 'generated' and exercises the sandbox harness:
//
//   1. seed a project + confirmed SystemSpec + approved Orchestration
//      Plan + a system build at status='generated' with files
//   2. loadGeneratedSystemBuildForTest → returns the chain
//   3. runSystemSandbox → REAL handoff parsing + REAL self-heal
//      orchestration; ONLY the SandboxProvider (install/build/smoke
//      execs) and the per-node LLM call (complete) are stubbed
//   4. persistSystemRunnerResult + persistRegeneratedModuleFiles →
//      build status flips, sandbox_run row stores phases + self-heal
//   5. STOP: confirm Phase 1 sandbox loader still refuses the system
//      build with 409, and no deployments / agent_runtimes appear.
//
// Three cases:
//   - passing smoke (no self-heal)
//   - failing smoke that self-heals to a pass (iterations=1, exactly
//     one regen)
//   - persistent failure (smoke fails, self-heal attempts once, second
//     smoke also fails → 'test_failed', NO second self-heal)
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SystemSpecSchema,
  type SystemSpec,
} from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';
import {
  loadGeneratedBuildForTest,
} from '@/lib/engine/sandbox/persistence';
import {
  loadGeneratedSystemBuildForTest,
  loadLatestSystemSandboxRun,
  insertRunningSystemSandboxRun,
  logSystemSandboxStarted,
  logSystemSandboxOutcome,
  markSystemBuildTesting,
  persistRegeneratedModuleFiles,
  persistSystemRunnerResult,
} from '@/lib/engine/system/sandbox/persistence';
import { recordCost } from '@/lib/engine/governance/ledger';
import {
  createInMemoryDb,
  makeClient,
} from '../helpers/in-memory-supabase';
import type {
  Build,
  BuildFile,
  Plan,
  Project,
  SandboxRun,
  Spec,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Mock the LLM `complete()` so the reused per-file generator runs
// without network for the self-heal path.
// ---------------------------------------------------------------------------
vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return { ...actual, complete: vi.fn() };
});

// Mock resolveKey so the runner's BYOK check passes without touching
// the connections table or env. We default to a synthetic byok key;
// individual tests can swap behaviour via mockReturnValue.
vi.mock('@/lib/engine/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/keys')>();
  return {
    ...actual,
    resolveKey: vi.fn(async () => ({ key: 'sk-test-e2b', source: 'byok' as const })),
  };
});

// Mock recordCost (the runner bills sandbox compute on every run).
vi.mock('@/lib/engine/governance/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/ledger')>();
  return {
    ...actual,
    recordCost: vi.fn(async () => ({ amount_usd: 0.001, event_id: 'evt-fake' })),
  };
});

// Mock the sandbox provider factory. Each test scripts the provider's
// install/build/smoke exec responses; the runner walks them in order.
vi.mock('@/lib/engine/sandbox/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/sandbox/provider')>();
  return {
    ...actual,
    selectProvider: vi.fn(),
  };
});

import { complete } from '@/lib/engine/llm';
import { selectProvider, type SandboxProvider } from '@/lib/engine/sandbox/provider';
import { runSystemSandbox } from '@/lib/engine/system/sandbox/runner';

// ---------------------------------------------------------------------------
// Canned data.
// ---------------------------------------------------------------------------

const USER_ID = 'user-sys-sandbox-dry-run';
const PROJECT_ID = 'project-sys-sandbox-dry-run';

const CANNED_SYSTEM_SPEC: SystemSpec = SystemSpecSchema.parse({
  goal: 'arxiv pipeline',
  sub_agents: [
    {
      id: 'scraper',
      role: 'scraper',
      description: 'pulls listings',
      inputs: ['time_window'],
      outputs: ['raw_papers'],
    },
    {
      id: 'summarizer',
      role: 'summarizer',
      description: 'summarises',
      inputs: ['raw_papers'],
      outputs: ['summary'],
    },
    {
      id: 'emailer',
      role: 'emailer',
      description: 'emails',
      inputs: ['summary'],
      outputs: ['delivery_receipt'],
    },
  ],
  coordination: { pattern: 'pipeline' },
  triggers: ['schedule'],
});

const CANNED_ORCH_PLAN: OrchestrationPlan = OrchestrationPlanSchema.parse({
  goal: 'arxiv pipeline',
  pattern: 'pipeline',
  max_steps: CANNED_SYSTEM_SPEC.max_steps,
  nodes: [
    {
      id: 'scraper',
      role: 'scraper',
      task: 'fetch arxiv',
      inputs: [{ from: null, output: 'time_window' }],
      outputs: ['raw_papers'],
      suggested_tools: [
        {
          requested: 'web_search',
          status: 'supported',
          registry_id: 'web_search',
          env_keys: [],
        },
      ],
    },
    {
      id: 'summarizer',
      role: 'summarizer',
      task: 'summarise',
      inputs: [{ from: 'scraper', output: 'raw_papers' }],
      outputs: ['summary'],
      suggested_tools: [
        {
          requested: 'llm_completion',
          status: 'supported',
          registry_id: 'llm_completion',
          env_keys: ['ANTHROPIC_API_KEY'],
        },
      ],
    },
    {
      id: 'emailer',
      role: 'emailer',
      task: 'email',
      inputs: [{ from: 'summarizer', output: 'summary' }],
      outputs: ['delivery_receipt'],
      suggested_tools: [
        {
          requested: 'email_send',
          status: 'needs_key',
          registry_id: 'email_send',
          env_keys: ['RESEND_API_KEY'],
        },
      ],
    },
  ],
  edges: [
    { from: 'scraper', to: 'summarizer', payload: 'raw_papers' },
    { from: 'summarizer', to: 'emailer', payload: 'summary' },
  ],
  execution_order: ['scraper', 'summarizer', 'emailer'],
  warnings: [],
});

// ---------------------------------------------------------------------------
// Fake SandboxProvider — scripts a sequence of exec results in order.
// The runner calls writeFiles → exec(install) → exec(build) → exec(smoke).
// Self-heal then calls writeFiles(patched module) → exec(build) → exec(smoke).
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
  let execIndex = 0;
  const exec = vi.fn(async (_cmd: string) => {
    const next = execScript[execIndex];
    execIndex++;
    if (!next) {
      // Runner stepped beyond the scripted exec count — surface loudly
      // so we don't silently pretend everything is fine.
      throw new Error(
        'fake provider: ran out of scripted execs at index ' + (execIndex - 1),
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
  return {
    stdout,
    stderr,
    exitCode: 0,
    timedOut: false,
    durationMs: 100,
  };
}

function fail(stdout = '', stderr = '', exitCode = 1): ExecResultLite {
  return {
    stdout,
    stderr,
    exitCode,
    timedOut: false,
    durationMs: 100,
  };
}

// Build a happy-path smoke output (the format the system smoke driver
// emits when orchestrate() succeeds).
function smokePassOutput(): ExecResultLite {
  return ok(
    '[smoke] orchestrate_passed {"steps":3,"final_node":"emailer"}\n',
    '',
  );
}

// Build a failing smoke output that names a failing node (the format
// the smoke driver emits when the orchestrator catches a handoff
// validation failure).
function smokeFailOutput(nodeId: string): ExecResultLite {
  return fail(
    '[smoke] orchestrate_failed ' +
      JSON.stringify({ node: nodeId, message: 'handoff validation failed' }) +
      '\n',
    '',
    1,
  );
}

function smokeUnrecoverableOutput(): ExecResultLite {
  // Driver couldn't even load the orchestrator — no failing node id
  // surfaces, so the runner can't self-heal.
  return fail(
    '[smoke] orchestrator_load_failed {"error":"module not found"}\n',
    '',
    2,
  );
}

// ---------------------------------------------------------------------------
// Seed helpers.
// ---------------------------------------------------------------------------

function seedSystemBuild(db: ReturnType<typeof createInMemoryDb>): {
  project: Project;
  spec: Spec;
  plan: Plan;
  build: Build;
  files: BuildFile[];
} {
  const project: Project = {
    id: PROJECT_ID,
    user_id: USER_ID,
    name: 'arXiv System',
    status: 'plan_approved',
    kind: 'system',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-sys-1',
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
    id: 'plan-sys-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_ORCH_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'system',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-sys-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: 'generated',
    logs: { static_checks: [], warnings: [] } as unknown as Build['logs'],
    repo_url: null,
    deploy_url: null,
    kind: 'system',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const files: BuildFile[] = [
    {
      id: 'f-1',
      build_id: build.id,
      path: 'src/orchestrator.ts',
      content: '// orchestrator placeholder\nexport function orchestrate(){}\n',
      source: 'generated',
      bytes: 60,
      created_at: new Date().toISOString(),
    },
    {
      id: 'f-2',
      build_id: build.id,
      path: 'src/modules/scraper/index.ts',
      content: 'export async function run(){ return { raw_papers: [] }; }\n',
      source: 'generated',
      bytes: 50,
      created_at: new Date().toISOString(),
    },
    {
      id: 'f-3',
      build_id: build.id,
      path: 'src/modules/summarizer/index.ts',
      content: 'export async function run(){ return { summary: "x" }; }\n',
      source: 'generated',
      bytes: 50,
      created_at: new Date().toISOString(),
    },
    {
      id: 'f-4',
      build_id: build.id,
      path: 'src/modules/emailer/index.ts',
      content: 'export async function run(){ return { delivery_receipt: 1 }; }\n',
      source: 'generated',
      bytes: 50,
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

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(complete).mockReset();
  vi.mocked(selectProvider).mockReset();
  vi.mocked(recordCost).mockReset();
  vi.mocked(recordCost).mockResolvedValue({
    amount_usd: 0.001,
    event_id: 'evt-fake',
  });
});

describe('Phase 2 SYSTEM sandbox hermetic dry-run', () => {
  // ========================================================================
  // PASSING SMOKE — no self-heal needed.
  // ========================================================================
  it('happy path: install → build → smoke passes; build → "tested"; sandbox destroyed', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSystemBuildForTest
    >[0];

    const { build } = seedSystemBuild(db);

    const { provider, spies } = makeFakeProvider([
      ok('install ok'),
      ok('tsc ok'),
      smokePassOutput(),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    // Drive the runner — loader returns the chain, runner runs the
    // scripted provider, persistence stores the result.
    const ctx = await loadGeneratedSystemBuildForTest(supabase, build.project_id);
    expect('error' in ctx).toBe(false);
    if ('error' in ctx) throw new Error(ctx.error);

    const run = await insertRunningSystemSandboxRun(supabase, build.id, 'fake');
    await logSystemSandboxStarted(supabase, build, run.id, 'fake');
    await markSystemBuildTesting(supabase, build.id);

    const result = await runSystemSandbox({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      governance: {
        user_id: USER_ID,
        project_id: PROJECT_ID,
        ref: 'system.sandbox.test',
      },
    });

    await persistRegeneratedModuleFiles(supabase, build.id, result);
    await persistSystemRunnerResult(supabase, { runId: run.id, build, result });
    await logSystemSandboxOutcome(supabase, build, run.id, result);

    // === Pass / no self-heal ===
    expect(result.passed).toBe(true);
    expect(result.build_ok).toBe(true);
    expect(result.smoke_ok).toBe(true);
    expect(result.iterations).toBe(0);
    expect(result.selfHealAttempts).toEqual([]);
    expect(result.error).toBeNull();

    // === Phases captured (install + build + smoke, all iteration 0) ===
    const phaseSummary = result.phases.map((p) => ({
      phase: p.phase,
      status: p.status,
      iteration: p.iteration,
    }));
    expect(phaseSummary).toEqual([
      { phase: 'install', status: 'ok', iteration: 0 },
      { phase: 'build', status: 'ok', iteration: 0 },
      { phase: 'smoke', status: 'ok', iteration: 0 },
    ]);

    // === Sandbox lifecycle: create + destroy ALWAYS called ===
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.destroy).toHaveBeenCalledTimes(1);
    // writeFiles is called twice: project files + smoke driver.
    expect(spies.writeFiles).toHaveBeenCalledTimes(2);
    // exec called exactly 3 times in the happy path.
    expect(spies.exec).toHaveBeenCalledTimes(3);

    // === Persistence: build → 'tested', sandbox_run → 'passed' ===
    const reloadedBuild = (db.tables.builds ?? []).find(
      (r) => r.id === build.id,
    ) as (Build & Record<string, unknown>) | undefined;
    expect(reloadedBuild?.status).toBe('tested');
    const reloadedRun = await loadLatestSystemSandboxRun(supabase, build.id);
    expect(reloadedRun?.status).toBe('passed');
    expect(reloadedRun?.build_ok).toBe(true);
    expect(reloadedRun?.smoke_ok).toBe(true);
    expect(reloadedRun?.iterations).toBe(0);

    // === Audit log carries the started + passed trail ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'system.sandbox_started')).toBe(true);
    expect(audit.some((r) => r.action === 'system.sandbox_passed')).toBe(true);
    expect(audit.some((r) => r.action === 'system.selfheal_attempted')).toBe(false);

    // === Ledger billed for sandbox compute (key_source from BYOK) ===
    expect(recordCost).toHaveBeenCalled();
    const ledgerCall = vi.mocked(recordCost).mock.calls[0]?.[0];
    expect(ledgerCall).toBeDefined();
    if (!ledgerCall) throw new Error('unreachable');
    expect(ledgerCall.kind).toBe('sandbox');
    expect(ledgerCall.user_id).toBe(USER_ID);
    expect(ledgerCall.key_source).toBe('byok');
    expect(typeof ledgerCall.compute_ms).toBe('number');

    // === STOP: Phase 1 sandbox loader 409s the system build ===
    const phase1 = await loadGeneratedBuildForTest(supabase, build.project_id);
    expect('error' in phase1).toBe(true);
    if ('error' in phase1) {
      expect(phase1.status).toBe(409);
      expect(phase1.error).toMatch(/system/i);
      expect(phase1.error).toMatch(/system\/build\/test/i);
    }
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
  });

  // ========================================================================
  // SELF-HEAL → PASS — one bounded retry succeeds.
  // ========================================================================
  it('self-heal: first smoke fails on a known node, regen + retry passes; iterations=1', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSystemBuildForTest
    >[0];

    const { build } = seedSystemBuild(db);

    // Script: install ok → build ok → smoke FAILS (node=summarizer)
    //                                  → build ok (retry) → smoke ok.
    const { provider, spies } = makeFakeProvider([
      ok('install ok'),
      ok('tsc ok'),
      smokeFailOutput('summarizer'),
      ok('tsc ok'),
      smokePassOutput(),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    // The self-heal calls regenerateSystemModule → generateOneAgentFile
    // → complete(). One LLM call per regen; we return a parseable
    // module body the static check will accept.
    vi.mocked(complete).mockResolvedValueOnce({
      text: [
        'export async function run(',
        '  input: Record<string, unknown>,',
        '): Promise<Record<string, unknown>> {',
        '  return { summary: "ok" };',
        '}',
      ].join('\n'),
      usage: { input_tokens: 100, output_tokens: 80 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const ctx = await loadGeneratedSystemBuildForTest(supabase, build.project_id);
    if ('error' in ctx) throw new Error(ctx.error);

    const run = await insertRunningSystemSandboxRun(supabase, build.id, 'fake');
    await logSystemSandboxStarted(supabase, build, run.id, 'fake');
    await markSystemBuildTesting(supabase, build.id);

    const result = await runSystemSandbox({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      governance: {
        user_id: USER_ID,
        project_id: PROJECT_ID,
        ref: 'system.sandbox.test',
      },
    });

    await persistRegeneratedModuleFiles(supabase, build.id, result);
    await persistSystemRunnerResult(supabase, { runId: run.id, build, result });
    await logSystemSandboxOutcome(supabase, build, run.id, result);

    // === Self-heal fired exactly once and succeeded ===
    expect(result.passed).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.selfHealAttempts).toHaveLength(1);
    expect(result.selfHealAttempts[0]?.node_id).toBe('summarizer');
    expect(result.selfHealAttempts[0]?.module_regen_ok).toBe(true);
    expect(result.selfHealAttempts[0]?.smoke_ok_after_retry).toBe(true);

    // === Phase trail shows iteration 0 (fail) + iteration 1 (ok) ===
    const phaseSummary = result.phases.map((p) => ({
      phase: p.phase,
      status: p.status,
      iteration: p.iteration,
    }));
    expect(phaseSummary).toEqual([
      { phase: 'install', status: 'ok', iteration: 0 },
      { phase: 'build', status: 'ok', iteration: 0 },
      { phase: 'smoke', status: 'failed', iteration: 0 },
      { phase: 'build', status: 'ok', iteration: 1 },
      { phase: 'smoke', status: 'ok', iteration: 1 },
    ]);

    // === Regen LLM was called EXACTLY ONCE — proves the hard cap on
    // self-heal attempts. A second LLM call would mean a second
    // self-heal which is forbidden.
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1);

    // === Provider lifecycle still single-shot: create + destroy ===
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.destroy).toHaveBeenCalledTimes(1);
    // writeFiles called THREE times: initial files + smoke driver + patched module.
    expect(spies.writeFiles).toHaveBeenCalledTimes(3);

    // === Patched module is persisted back to build_files ===
    const buildFileRows = (db.tables.build_files ?? []) as Array<
      Record<string, unknown>
    >;
    const summarizerRow = buildFileRows.find(
      (r) => r.path === 'src/modules/summarizer/index.ts',
    );
    expect(summarizerRow).toBeDefined();
    expect(String(summarizerRow?.content)).toContain('summary: "ok"');

    // === Build status flipped to 'tested' ===
    const reloadedBuild = (db.tables.builds ?? []).find(
      (r) => r.id === build.id,
    ) as (Build & Record<string, unknown>) | undefined;
    expect(reloadedBuild?.status).toBe('tested');

    // === Audit log has the self-heal trail ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    const selfHealRow = audit.find(
      (r) => r.action === 'system.selfheal_attempted',
    );
    expect(selfHealRow).toBeDefined();
    expect(audit.some((r) => r.action === 'system.sandbox_passed')).toBe(true);

    // === Sandbox destroyed ===
    const reloadedRun = await loadLatestSystemSandboxRun(supabase, build.id);
    expect(reloadedRun?.status).toBe('passed');
    expect(reloadedRun?.iterations).toBe(1);
  });

  // ========================================================================
  // PERSISTENT FAILURE — first smoke fails, self-heal regenerates ONCE,
  // second smoke also fails. No second self-heal. build → 'test_failed'.
  // ========================================================================
  it('persistent fail: smoke fails again after self-heal; iterations=1; NO second retry', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSystemBuildForTest
    >[0];

    const { build } = seedSystemBuild(db);

    // Script: install ok → build ok → smoke FAIL (summarizer)
    //                                  → build ok → smoke FAIL again.
    // The runner MUST NOT script a third smoke; we add NO further entries.
    const { provider, spies } = makeFakeProvider([
      ok('install ok'),
      ok('tsc ok'),
      smokeFailOutput('summarizer'),
      ok('tsc ok'),
      smokeFailOutput('summarizer'),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    vi.mocked(complete).mockResolvedValueOnce({
      text: [
        'export async function run(',
        '  input: Record<string, unknown>,',
        '): Promise<Record<string, unknown>> {',
        '  return { summary: "still wrong" };',
        '}',
      ].join('\n'),
      usage: { input_tokens: 100, output_tokens: 80 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const ctx = await loadGeneratedSystemBuildForTest(supabase, build.project_id);
    if ('error' in ctx) throw new Error(ctx.error);

    const run = await insertRunningSystemSandboxRun(supabase, build.id, 'fake');
    await logSystemSandboxStarted(supabase, build, run.id, 'fake');
    await markSystemBuildTesting(supabase, build.id);

    const result = await runSystemSandbox({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      governance: {
        user_id: USER_ID,
        project_id: PROJECT_ID,
        ref: 'system.sandbox.test',
      },
    });

    await persistRegeneratedModuleFiles(supabase, build.id, result);
    await persistSystemRunnerResult(supabase, { runId: run.id, build, result });
    await logSystemSandboxOutcome(supabase, build, run.id, result);

    // === Failed, exactly one self-heal attempt ===
    expect(result.passed).toBe(false);
    expect(result.smoke_ok).toBe(false);
    expect(result.iterations).toBe(1);
    expect(result.selfHealAttempts).toHaveLength(1);
    expect(result.selfHealAttempts[0]?.smoke_ok_after_retry).toBe(false);

    // === No further LLM calls beyond the single self-heal ===
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1);

    // === Exec count: 5 (install + 2 × build + 2 × smoke). NO third smoke. ===
    expect(spies.exec).toHaveBeenCalledTimes(5);

    // === Sandbox still destroyed exactly once ===
    expect(spies.destroy).toHaveBeenCalledTimes(1);

    // === Build flipped to 'test_failed', not 'failed' ===
    const reloadedBuild = (db.tables.builds ?? []).find(
      (r) => r.id === build.id,
    ) as (Build & Record<string, unknown>) | undefined;
    expect(reloadedBuild?.status).toBe('test_failed');

    const reloadedRun = await loadLatestSystemSandboxRun(supabase, build.id);
    expect(reloadedRun?.status).toBe('failed');
    expect(reloadedRun?.iterations).toBe(1);

    // === Audit log: started + selfheal_attempted + sandbox_failed ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'system.sandbox_started')).toBe(true);
    expect(audit.some((r) => r.action === 'system.selfheal_attempted')).toBe(true);
    expect(audit.some((r) => r.action === 'system.sandbox_failed')).toBe(true);
    expect(audit.some((r) => r.action === 'system.sandbox_passed')).toBe(false);

    // === Downstream still closed ===
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
  });

  // ========================================================================
  // UNRECOVERABLE SMOKE — driver fails BEFORE the orchestrator returns a
  // failing node id (e.g. orchestrator_load_failed). Self-heal can't fire
  // because we don't know which module to regenerate. Sandbox cleanly
  // marks 'test_failed' without crashing.
  // ========================================================================
  it('unrecoverable smoke: no failing node id surfaces → no self-heal attempt, clean test_failed', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSystemBuildForTest
    >[0];

    const { build } = seedSystemBuild(db);

    const { provider, spies } = makeFakeProvider([
      ok('install ok'),
      ok('tsc ok'),
      smokeUnrecoverableOutput(),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    const ctx = await loadGeneratedSystemBuildForTest(supabase, build.project_id);
    if ('error' in ctx) throw new Error(ctx.error);

    const run = await insertRunningSystemSandboxRun(supabase, build.id, 'fake');
    await logSystemSandboxStarted(supabase, build, run.id, 'fake');
    await markSystemBuildTesting(supabase, build.id);

    const result = await runSystemSandbox({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      governance: {
        user_id: USER_ID,
        project_id: PROJECT_ID,
        ref: 'system.sandbox.test',
      },
    });
    await persistSystemRunnerResult(supabase, { runId: run.id, build, result });
    await logSystemSandboxOutcome(supabase, build, run.id, result);

    expect(result.passed).toBe(false);
    expect(result.iterations).toBe(0);
    expect(result.selfHealAttempts).toEqual([]);
    // No regen LLM call.
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(0);
    // No re-build, no re-smoke.
    expect(spies.exec).toHaveBeenCalledTimes(3);
    expect(spies.destroy).toHaveBeenCalledTimes(1);

    const reloadedBuild = (db.tables.builds ?? []).find(
      (r) => r.id === build.id,
    ) as (Build & Record<string, unknown>) | undefined;
    expect(reloadedBuild?.status).toBe('test_failed');
  });

  // ========================================================================
  // Misroute: system sandbox loader refuses an agent project.
  // ========================================================================
  it('loadGeneratedSystemBuildForTest rejects an agent project with 409', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSystemBuildForTest
    >[0];

    db.tables.projects = [
      {
        id: 'p-agent-1',
        user_id: USER_ID,
        name: 'agent-project',
        status: 'plan_approved',
        kind: 'agent',
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.builds = [
      {
        id: 'b-agent-1',
        project_id: 'p-agent-1',
        spec_id: 'sx',
        plan_id: 'px',
        phase: 'codegen',
        status: 'generated',
        logs: { static_checks: [], warnings: [] },
        repo_url: null,
        deploy_url: null,
        kind: 'agent',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const result = await loadGeneratedSystemBuildForTest(supabase, 'p-agent-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/no system build/i);
    }
  });

  // ========================================================================
  // Hermeticity — zero real fetch.
  // ========================================================================
  it('zero real fetch calls across the whole system sandbox dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
