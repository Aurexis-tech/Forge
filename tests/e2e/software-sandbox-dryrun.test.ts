// Hermetic end-to-end dry-run — Phase 3 (Software) SANDBOX.
//
// Companion to software-codegen-dryrun.test.ts. That file drives
// the codegen side and stops at 'generated'; this file picks up at
// 'generated' and exercises the sandbox harness:
//
//   1. seed a project + confirmed SoftwareSpec + approved software
//      plan + a software build at status='generated' with files
//   2. loadGeneratedSoftwareBuildForTest                  → returns chain
//   3. runSoftwareSandbox                                   → REAL phase
//      orchestration; ONLY the SandboxProvider exec results (install
//      / next build / pglite install / isolation driver) are stubbed
//   4. persistSoftwareRunnerResult + persistSoftwareRegeneratedFiles
//   5. STOP: software still cannot reach DB provisioning / deploy /
//      runtime — proven by the Phase 1 + 2 sandbox loaders 409-ing
//      a software build with the new-route hint, and by no
//      deployments / agent_runtimes rows.
//
// Four scenarios:
//   - BUILD pass + ISOLATION pass (B sees zero of A): 'tested'.
//   - BUILD pass + ISOLATION fails: 'test_failed' as a HARD STOP —
//     NO self-heal, software.isolation_failed audit row present.
//   - BUILD fails on a fixable LLM slot: ONE self-heal attempt; if
//     the retry still fails, 'test_failed'.
//   - Phase 1 + 2 sandbox loaders 409 a software build.
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SoftwareSpecSchema,
  type SoftwareSpec,
} from '@/lib/engine/software/spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '@/lib/engine/software/planner/schema';
import {
  loadGeneratedBuildForTest,
} from '@/lib/engine/sandbox/persistence';
import {
  loadGeneratedSystemBuildForTest,
} from '@/lib/engine/system/sandbox/persistence';
import {
  loadGeneratedSoftwareBuildForTest,
  loadLatestSoftwareSandboxRun,
  insertRunningSoftwareSandboxRun,
  logSoftwareSandboxStarted,
  logSoftwareSandboxOutcome,
  markSoftwareBuildTesting,
  persistSoftwareRegeneratedFiles,
  persistSoftwareRunnerResult,
} from '@/lib/engine/software/sandbox/persistence';
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
// Boundary mocks.
// ---------------------------------------------------------------------------

vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return { ...actual, complete: vi.fn() };
});

vi.mock('@/lib/engine/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/keys')>();
  return {
    ...actual,
    resolveKey: vi.fn(async () => ({ key: 'sk-test-e2b', source: 'byok' as const })),
  };
});

vi.mock('@/lib/engine/governance/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/ledger')>();
  return {
    ...actual,
    recordCost: vi.fn(async () => ({ amount_usd: 0.002, event_id: 'evt-fake' })),
  };
});

vi.mock('@/lib/engine/sandbox/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/sandbox/provider')>();
  return { ...actual, selectProvider: vi.fn() };
});

import { complete } from '@/lib/engine/llm';
import {
  selectProvider,
  type SandboxProvider,
} from '@/lib/engine/sandbox/provider';
import { runSoftwareSandbox } from '@/lib/engine/software/sandbox/runner';

// ---------------------------------------------------------------------------
// Canned data — expenses tracker shape with 2 entities + 3 pages,
// per_user_isolation on.
// ---------------------------------------------------------------------------

const USER_ID = 'user-sw-sandbox-dry-run';
const PROJECT_ID = 'project-sw-sandbox-dry-run';

const CANNED_SOFTWARE_SPEC: SoftwareSpec = SoftwareSpecSchema.parse({
  goal: 'Team expenses tracker',
  pages: [
    { id: 'submit_expense', name: 'Submit', purpose: 'Submit an expense.' },
    { id: 'my_history', name: 'History', purpose: 'My past expenses.' },
    { id: 'approvals', name: 'Approvals', purpose: 'Approve expenses.' },
  ],
  entities: [
    {
      name: 'Expense',
      fields: [
        { name: 'submitted_by', type: 'reference' },
        { name: 'amount', type: 'number' },
      ],
    },
    {
      name: 'User',
      fields: [{ name: 'email', type: 'email' }],
    },
  ],
  flows: [
    {
      name: 'Submit',
      description: 'submit an expense',
      pages: ['submit_expense'],
    },
  ],
  auth: { requires_auth: true, per_user_isolation: true },
});

const CANNED_SW_PLAN: SoftwareBuildPlan = SoftwareBuildPlanSchema.parse({
  template_id: 'nextjs-supabase-app',
  tasks: [
    {
      id: 'migration_expense',
      layer: 'schema',
      description: 'x',
      depends_on: [],
      slot: { kind: 'entity_migration', target: 'Expense' },
      files: [],
    },
    {
      id: 'api_list_expense',
      layer: 'api',
      description: 'x',
      depends_on: ['migration_expense'],
      slot: { kind: 'list_route', target: 'Expense' },
      files: [],
    },
    {
      id: 'page_submit',
      layer: 'ui',
      description: 'x',
      depends_on: ['api_list_expense'],
      slot: { kind: 'page_component', target: 'submit_expense' },
      files: [],
    },
    {
      id: 'auth_session',
      layer: 'auth',
      description: 'x',
      depends_on: [],
      slot: { kind: 'session_middleware', target: null },
      files: [],
    },
  ],
  execution_order: [
    'migration_expense',
    'api_list_expense',
    'auth_session',
    'page_submit',
  ],
  warnings: [],
});

// ---------------------------------------------------------------------------
// Fake SandboxProvider — scripts exec results in order.
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

function isolationPassed(): ExecResultLite {
  return ok(
    '[isolation] schema_applied {"tables":["expense","user"]}\n' +
      '[isolation] users_created {"a":"aaaa","b":"bbbb"}\n' +
      '[isolation] passed {"entities":["expense","user"],"a_wrote":{"expense":1,"user":1},"b_saw_a":{"expense":0,"user":0}}\n',
    '',
  );
}

function isolationLeaked(): ExecResultLite {
  return fail(
    '[isolation] schema_applied {"tables":["expense","user"]}\n' +
      '[isolation] users_created {"a":"aaaa","b":"bbbb"}\n' +
      '[isolation] failed {"entities":["expense","user"],"a_wrote":{"expense":1,"user":1},"b_saw_a":{"expense":2,"user":0},"leak_count":2,"first_leak_table":"expense","reason":"B read 2 of A\'s owner-scoped rows — RLS leak"}\n',
    '',
    1,
  );
}

// next build failure tail that points at a fixable LLM slot file.
function buildFailedAtSlot(): ExecResultLite {
  return fail(
    '',
    [
      'Failed to compile.',
      '',
      './app/api/expense/_list.ts',
      "TS2304: Cannot find name 'foo'.",
      '',
    ].join('\n'),
    1,
  );
}

// ---------------------------------------------------------------------------
// Seed helpers.
// ---------------------------------------------------------------------------

function seedSoftwareBuild(db: ReturnType<typeof createInMemoryDb>): {
  project: Project;
  spec: Spec;
  plan: Plan;
  build: Build;
  files: BuildFile[];
} {
  const project: Project = {
    id: PROJECT_ID,
    user_id: USER_ID,
    name: 'Team Expenses',
    status: 'plan_approved',
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-sw-sandbox-1',
    project_id: project.id,
    raw_prompt: 'expenses tracker',
    structured_spec: CANNED_SOFTWARE_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'confirmed',
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const plan: Plan = {
    id: 'plan-sw-sandbox-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_SW_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-sw-sandbox-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: 'generated',
    logs: { static_checks: [], warnings: [] } as unknown as Build['logs'],
    repo_url: null,
    deploy_url: null,
    kind: 'software',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const files: BuildFile[] = [
    {
      id: 'f-1',
      build_id: build.id,
      path: 'supabase/migrations/0001_init.sql',
      content: '-- migration\n',
      source: 'generated',
      bytes: 20,
      created_at: new Date().toISOString(),
    },
    {
      id: 'f-2',
      build_id: build.id,
      path: 'app/api/expense/_list.ts',
      content: 'export async function GET(){return Response.json({})}\n',
      source: 'generated',
      bytes: 50,
      created_at: new Date().toISOString(),
    },
    {
      id: 'f-3',
      build_id: build.id,
      path: 'app/(app)/submit-expense/page.tsx',
      content: 'export default function P(){return null}\n',
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
    amount_usd: 0.002,
    event_id: 'evt-fake',
  });
});

describe('Phase 3 SOFTWARE sandbox hermetic dry-run', () => {
  // ========================================================================
  // BUILD pass + ISOLATION pass — the happy path.
  // ========================================================================
  it('happy path: install → build → isolation passes; build → "tested"; sandbox destroyed', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSoftwareBuildForTest
    >[0];

    const { build } = seedSoftwareBuild(db);

    // install (npm) → next build → install (pglite) → isolation
    const { provider, spies } = makeFakeProvider([
      ok('npm install ok'),
      ok('next build ok'),
      ok('pglite install ok'),
      isolationPassed(),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    const ctx = await loadGeneratedSoftwareBuildForTest(supabase, build.project_id);
    expect('error' in ctx).toBe(false);
    if ('error' in ctx) throw new Error(ctx.error);

    const run = await insertRunningSoftwareSandboxRun(supabase, build.id, 'fake');
    await logSoftwareSandboxStarted(supabase, build, run.id, 'fake');
    await markSoftwareBuildTesting(supabase, build.id);

    const result = await runSoftwareSandbox({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      governance: {
        user_id: USER_ID,
        project_id: PROJECT_ID,
        ref: 'software.sandbox.test',
      },
    });

    await persistSoftwareRegeneratedFiles(supabase, build.id, result);
    await persistSoftwareRunnerResult(supabase, { runId: run.id, build, result });
    await logSoftwareSandboxOutcome(supabase, build, run.id, result);

    // === Pass / no self-heal ===
    expect(result.passed).toBe(true);
    expect(result.build_ok).toBe(true);
    expect(result.isolation_ok).toBe(true);
    expect(result.iterations).toBe(0);
    expect(result.selfHealAttempts).toEqual([]);

    // === Isolation result captured + per-entity B-saw-A counts are zero ===
    expect(result.isolation).toBeTruthy();
    expect(result.isolation?.outcome).toBe('passed');
    expect(result.isolation?.leakCount).toBe(0);
    expect(result.isolation?.perEntity.expense?.bSawA).toBe(0);
    expect(result.isolation?.perEntity.user?.bSawA).toBe(0);
    expect(result.isolation?.perEntity.expense?.aWrote).toBe(1);

    // === Phases captured (install + build + isolation, iteration 0) ===
    const phaseSummary = result.phases.map((p) => ({
      phase: String(p.phase),
      status: p.status,
      iteration: p.iteration,
    }));
    // install + build + install(pglite, recorded under 'install' bucket again) + isolation
    expect(phaseSummary[0]).toEqual({ phase: 'install', status: 'ok', iteration: 0 });
    expect(phaseSummary[1]).toEqual({ phase: 'build', status: 'ok', iteration: 0 });
    expect(phaseSummary.find((p) => p.phase === 'isolation')).toEqual({
      phase: 'isolation',
      status: 'ok',
      iteration: 0,
    });

    // === Sandbox lifecycle: create + destroy ALWAYS called ===
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.destroy).toHaveBeenCalledTimes(1);
    // 4 execs scripted, all consumed.
    expect(spies.exec).toHaveBeenCalledTimes(4);

    // === Persistence: build → 'tested', sandbox_run → 'passed' ===
    const reloadedBuild = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | (Build & Record<string, unknown>)
      | undefined;
    expect(reloadedBuild?.status).toBe('tested');
    const reloadedRun = await loadLatestSoftwareSandboxRun(supabase, build.id);
    expect(reloadedRun?.status).toBe('passed');
    expect(reloadedRun?.build_ok).toBe(true);
    expect(reloadedRun?.smoke_ok).toBe(true); // repurposed for isolation
    expect(reloadedRun?.iterations).toBe(0);

    // === Audit log carries started + passed; NO isolation_failed ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'software.sandbox_started')).toBe(true);
    expect(audit.some((r) => r.action === 'software.sandbox_passed')).toBe(true);
    expect(audit.some((r) => r.action === 'software.isolation_failed')).toBe(false);
    expect(audit.some((r) => r.action === 'software.selfheal_attempted')).toBe(false);

    // === Ledger billed for sandbox compute (BYOK) ===
    expect(recordCost).toHaveBeenCalled();
    const ledgerCall = vi.mocked(recordCost).mock.calls[0]?.[0];
    expect(ledgerCall?.kind).toBe('sandbox');
    expect(ledgerCall?.user_id).toBe(USER_ID);
    expect(ledgerCall?.key_source).toBe('byok');

    // === STOP: Phase 1 + 2 sandbox loaders 409 the software build ===
    const phase1 = await loadGeneratedBuildForTest(supabase, build.project_id);
    expect('error' in phase1).toBe(true);
    if ('error' in phase1) {
      expect(phase1.status).toBe(409);
      expect(phase1.error).toMatch(/software/i);
      expect(phase1.error).toMatch(/software\/build\/test/i);
    }
    const phase2 = await loadGeneratedSystemBuildForTest(supabase, build.project_id);
    expect('error' in phase2).toBe(true);
    if ('error' in phase2) {
      // Phase 2 filters by build.kind='system' so a software project
      // looks like "no system build" — that's adequate defence-in-depth.
      expect(phase2.status).toBe(409);
    }

    // === Downstream still closed: no deployments / agent_runtimes ===
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
  });

  // ========================================================================
  // ISOLATION FAILS — HARD STOP, no self-heal.
  // ========================================================================
  it('isolation fail: build passes, RLS leaks; build → "test_failed"; software.isolation_failed audit; NO self-heal', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSoftwareBuildForTest
    >[0];

    const { build } = seedSoftwareBuild(db);

    // install → build → install(pglite) → isolation LEAKED
    const { provider, spies } = makeFakeProvider([
      ok('npm install ok'),
      ok('next build ok'),
      ok('pglite install ok'),
      isolationLeaked(),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    const ctx = await loadGeneratedSoftwareBuildForTest(supabase, build.project_id);
    if ('error' in ctx) throw new Error(ctx.error);

    const run = await insertRunningSoftwareSandboxRun(supabase, build.id, 'fake');
    await logSoftwareSandboxStarted(supabase, build, run.id, 'fake');
    await markSoftwareBuildTesting(supabase, build.id);

    const result = await runSoftwareSandbox({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      governance: {
        user_id: USER_ID,
        project_id: PROJECT_ID,
        ref: 'software.sandbox.test',
      },
    });

    await persistSoftwareRegeneratedFiles(supabase, build.id, result);
    await persistSoftwareRunnerResult(supabase, { runId: run.id, build, result });
    await logSoftwareSandboxOutcome(supabase, build, run.id, result);

    // === HARD STOP — no self-heal attempt fired ===
    expect(result.iterations).toBe(0);
    expect(result.selfHealAttempts).toEqual([]);
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(0);

    // === Build passed; isolation failed; overall failed ===
    expect(result.build_ok).toBe(true);
    expect(result.isolation_ok).toBe(false);
    expect(result.passed).toBe(false);

    // === Structured isolation result preserved (the audit needs it) ===
    expect(result.isolation?.outcome).toBe('failed');
    expect(result.isolation?.leakTable).toBe('expense');
    expect(result.isolation?.leakCount).toBe(2);
    expect(result.isolation?.perEntity.expense?.bSawA).toBe(2);
    expect(result.error).toMatch(/isolation FAILED/i);

    // === Sandbox still destroyed exactly once ===
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.destroy).toHaveBeenCalledTimes(1);
    // 4 execs (install + build + pglite install + isolation), NO fifth.
    expect(spies.exec).toHaveBeenCalledTimes(4);

    // === Build → 'test_failed', sandbox_run → 'failed' ===
    const reloadedBuild = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | (Build & Record<string, unknown>)
      | undefined;
    expect(reloadedBuild?.status).toBe('test_failed');
    const reloadedRun = await loadLatestSoftwareSandboxRun(supabase, build.id);
    expect(reloadedRun?.status).toBe('failed');
    expect(reloadedRun?.build_ok).toBe(true);
    expect(reloadedRun?.smoke_ok).toBe(false);

    // === Audit log: software.isolation_failed present (separate from
    // the generic sandbox_failed), software.selfheal_attempted absent. ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    const isolationFailed = audit.find(
      (r) => r.action === 'software.isolation_failed',
    );
    expect(isolationFailed).toBeDefined();
    expect(audit.some((r) => r.action === 'software.sandbox_failed')).toBe(true);
    expect(audit.some((r) => r.action === 'software.sandbox_passed')).toBe(false);
    expect(audit.some((r) => r.action === 'software.selfheal_attempted')).toBe(false);
  });

  // ========================================================================
  // BUILD FAILS — exactly one bounded self-heal; if it still fails,
  // 'test_failed'.
  // ========================================================================
  it('build fail at a fixable slot: ONE self-heal attempt fires; persistent failure → "test_failed"', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSoftwareBuildForTest
    >[0];

    const { build } = seedSoftwareBuild(db);

    // First pass: install ok → next build FAILS pointing at the slot.
    // Second pass after self-heal: next build still FAILS at the same slot.
    const { provider, spies } = makeFakeProvider([
      ok('npm install ok'),
      buildFailedAtSlot(),
      // Retry build only — we never reach isolation install/exec.
      buildFailedAtSlot(),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    // The self-heal calls regenerateSoftwareSlot → generateOneAgentFile
    // path internally → complete(). Return a parseable replacement body.
    vi.mocked(complete).mockResolvedValueOnce({
      text: [
        "import { createServerClient } from '@/lib/supabase/server';",
        'export async function GET(_request: Request): Promise<Response> {',
        '  const supabase = createServerClient();',
        "  const { data } = await supabase.from('expense').select('*');",
        '  return Response.json({ rows: data ?? [] }, { status: 200 });',
        '}',
      ].join('\n'),
      usage: { input_tokens: 200, output_tokens: 120 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const ctx = await loadGeneratedSoftwareBuildForTest(supabase, build.project_id);
    if ('error' in ctx) throw new Error(ctx.error);

    const run = await insertRunningSoftwareSandboxRun(supabase, build.id, 'fake');
    await logSoftwareSandboxStarted(supabase, build, run.id, 'fake');
    await markSoftwareBuildTesting(supabase, build.id);

    const result = await runSoftwareSandbox({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      governance: {
        user_id: USER_ID,
        project_id: PROJECT_ID,
        ref: 'software.sandbox.test',
      },
    });

    await persistSoftwareRegeneratedFiles(supabase, build.id, result);
    await persistSoftwareRunnerResult(supabase, { runId: run.id, build, result });
    await logSoftwareSandboxOutcome(supabase, build, run.id, result);

    // === Exactly one self-heal attempt, both build passes failed ===
    expect(result.iterations).toBe(1);
    expect(result.selfHealAttempts).toHaveLength(1);
    expect(result.selfHealAttempts[0]?.file_path).toBe(
      'app/api/expense/_list.ts',
    );
    expect(result.selfHealAttempts[0]?.build_ok_after_retry).toBe(false);
    expect(result.passed).toBe(false);

    // === Regen LLM was called EXACTLY ONCE — hard cap on self-heal ===
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1);

    // === Provider lifecycle still single-shot ===
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.destroy).toHaveBeenCalledTimes(1);
    // 3 execs: install + build@0 + build@1. NO pglite install, NO
    // isolation — we never made it past the (retry) build.
    expect(spies.exec).toHaveBeenCalledTimes(3);

    // === Patched module persisted back to build_files ===
    const buildFileRows = (db.tables.build_files ?? []) as Array<
      Record<string, unknown>
    >;
    const patched = buildFileRows.find(
      (r) => r.path === 'app/api/expense/_list.ts',
    );
    expect(patched).toBeDefined();
    expect(String(patched?.content)).toContain("from '@/lib/supabase/server'");

    // === Build flipped to 'test_failed' ===
    const reloadedBuild = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | (Build & Record<string, unknown>)
      | undefined;
    expect(reloadedBuild?.status).toBe('test_failed');

    // === Audit: selfheal_attempted present + sandbox_failed present ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'software.selfheal_attempted')).toBe(true);
    expect(audit.some((r) => r.action === 'software.sandbox_failed')).toBe(true);
    // Isolation never ran, so no isolation_failed.
    expect(audit.some((r) => r.action === 'software.isolation_failed')).toBe(false);
  });

  // ========================================================================
  // BUILD FAIL with unidentifiable slot — no self-heal can fire.
  // ========================================================================
  it('build fail with no LLM-slot match → no self-heal attempt, clean test_failed', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSoftwareBuildForTest
    >[0];

    const { build } = seedSoftwareBuild(db);

    // Build fails but the stderr doesn't point at any LLM-filled
    // slot path (e.g. a tsconfig error). Self-heal must NOT fire.
    const { provider, spies } = makeFakeProvider([
      ok('npm install ok'),
      fail('', 'tsconfig.json: invalid JSON\n', 1),
    ]);
    vi.mocked(selectProvider).mockReturnValue(provider);

    const ctx = await loadGeneratedSoftwareBuildForTest(supabase, build.project_id);
    if ('error' in ctx) throw new Error(ctx.error);

    const run = await insertRunningSoftwareSandboxRun(supabase, build.id, 'fake');
    const result = await runSoftwareSandbox({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      governance: {
        user_id: USER_ID,
        project_id: PROJECT_ID,
        ref: 'software.sandbox.test',
      },
    });
    await persistSoftwareRunnerResult(supabase, { runId: run.id, build, result });
    await logSoftwareSandboxOutcome(supabase, build, run.id, result);

    expect(result.iterations).toBe(0);
    expect(result.selfHealAttempts).toEqual([]);
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(0);
    expect(spies.exec).toHaveBeenCalledTimes(2); // install + build only
    expect(spies.destroy).toHaveBeenCalledTimes(1);

    const reloadedBuild = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | (Build & Record<string, unknown>)
      | undefined;
    expect(reloadedBuild?.status).toBe('test_failed');
  });

  // ========================================================================
  // Misroutes — Phase 1 + 2 sandbox loaders 409 a software build.
  // ========================================================================
  it('Phase 1 sandbox loader 409s a software build with the software-route hint', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedBuildForTest
    >[0];
    seedSoftwareBuild(db);

    const result = await loadGeneratedBuildForTest(supabase, PROJECT_ID);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/software/i);
      expect(result.error).toMatch(/software\/build\/test/i);
    }
  });

  it('loadGeneratedSoftwareBuildForTest rejects an agent project with 409', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadGeneratedSoftwareBuildForTest
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

    const result = await loadGeneratedSoftwareBuildForTest(supabase, 'p-agent-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/no software build/i);
    }
  });

  // ========================================================================
  // Hermeticity.
  // ========================================================================
  it('zero real fetch calls across the whole software sandbox dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
