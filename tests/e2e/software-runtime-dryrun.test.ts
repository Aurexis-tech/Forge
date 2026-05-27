// Hermetic end-to-end dry-run — Phase 3-6 (Software) RUNTIME + APP
// DASHBOARD.
//
// Companion to software-deploy-dryrun.test.ts. That file stops at
// build.status='deployed'; this file picks up there and exercises:
//
//   1. POST /software/runtime/activate behind the gate → kind='software'
//      runtime row created; build → 'running'
//   2. GATE: missing/false `authorized` → 403; no runtime row
//   3. KILL SWITCH: active project-scope kill switch blocks go-live
//      (governance:killed); on dashboard load with an active runtime,
//      the runtime is auto-paused → app reads offline; clearing the
//      switch restores the ability to go live
//   4. DASHBOARD PAYLOAD: assembled from spec + db + deployment +
//      runtime + killswitch; the service-role RAW value is NEVER on
//      the payload (asserted)
//   5. Misroute: Phase 1 + Phase 2 runtime/activate routes 409 a
//      software build with software-route hints
//   6. Zero real fetch.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Build,
  Deployment,
  Plan,
  Project,
  SoftwareDatabase,
  Spec,
} from '@/lib/types';
import { encryptSecret } from '@/lib/crypto';
import {
  SoftwareSpecSchema,
  type SoftwareSpec,
} from '@/lib/engine/software/spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '@/lib/engine/software/planner/schema';
import {
  assembleSoftwareDashboard,
} from '@/lib/engine/software/runtime/persistence';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Boundary mocks. Set BEFORE importing the route handlers.
// ---------------------------------------------------------------------------

const FAKE_USER = { id: 'user-sw-runtime-dry-run', email: 'test@example.com' };
const PROJECT_ID = 'project-sw-runtime-dry-run';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    requireUser: vi.fn(async () => FAKE_USER),
    requireProjectOwnership: vi.fn(async (id: string) => ({
      project: {
        id,
        user_id: FAKE_USER.id,
        name: 'Team Expenses',
        status: 'deployed',
        kind: 'software',
        created_at: new Date().toISOString(),
      } as Project,
    })),
  };
});

vi.mock('@/lib/engine/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/keys')>();
  return {
    ...actual,
    userHasAnyByok: vi.fn(async () => false),
  };
});

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

// Route handlers — imported AFTER the mocks are configured.
import { POST as softwareActivatePOST } from '@/app/api/projects/[id]/software/runtime/activate/route';
import { POST as agentActivatePOST } from '@/app/api/projects/[id]/runtime/activate/route';
import { POST as systemActivatePOST } from '@/app/api/projects/[id]/system/runtime/activate/route';
import {
  loadSoftwareRuntimeForProject,
  syncSoftwareRuntimeWithKillSwitch,
} from '@/lib/engine/software/runtime/persistence';
import { activeKillSwitch } from '@/lib/engine/governance/killswitch';
import type { ForgeSupabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Canned data.
// ---------------------------------------------------------------------------

const CANNED_SPEC: SoftwareSpec = SoftwareSpecSchema.parse({
  goal: 'Team expenses tracker',
  pages: [
    { id: 'submit_expense', name: 'Submit', purpose: 'Submit an expense.' },
  ],
  entities: [
    {
      name: 'Expense',
      fields: [
        { name: 'submitted_by', type: 'reference' },
        { name: 'amount', type: 'number' },
      ],
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

const CANNED_PLAN: SoftwareBuildPlan = SoftwareBuildPlanSchema.parse({
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
  ],
  execution_order: ['migration_expense'],
  warnings: [],
});

const RAW_SERVICE_ROLE = 'service-role-' + 'z'.repeat(80);

function seedDeployedSoftware(
  db: InMemoryDb,
  opts: { buildStatus?: 'deployed' | 'running' } = {},
): {
  project: Project;
  build: Build;
  dbRow: SoftwareDatabase;
  deployment: Deployment;
} {
  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: 'Team Expenses',
    status: 'deployed',
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-sw-runtime-1',
    project_id: project.id,
    raw_prompt: 'expenses tracker',
    structured_spec: CANNED_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'confirmed',
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const plan: Plan = {
    id: 'plan-sw-runtime-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-sw-runtime-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: opts.buildStatus ?? 'deployed',
    logs: { static_checks: [], warnings: [] } as unknown as Build['logs'],
    repo_url: 'https://github.com/forge-tester/team-expenses',
    deploy_url: 'https://team-expenses.vercel.app',
    kind: 'software',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const dbRow: SoftwareDatabase = {
    id: 'sd-1',
    project_id: project.id,
    build_id: build.id,
    provider_kind: 'managed',
    supabase_url: 'https://abcdef.supabase.co',
    anon_key: 'anon-' + 'a'.repeat(60),
    service_role_encrypted: encryptSecret(RAW_SERVICE_ROLE),
    service_role_last4: RAW_SERVICE_ROLE.slice(-4),
    provider_project_ref: 'abcdef',
    migration_applied: true,
    created_at: new Date().toISOString(),
  };
  const deployment: Deployment = {
    id: 'dep-1',
    build_id: build.id,
    provider: 'vercel',
    project_ref: 'prj_test',
    deployment_id: 'dpl_test',
    url: 'https://team-expenses.vercel.app',
    status: 'ready',
    env_keys: [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
    created_at: new Date().toISOString(),
  };
  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.software_databases = [
    dbRow as unknown as Record<string, unknown>,
  ];
  db.tables.deployments = [deployment as unknown as Record<string, unknown>];
  return { project, build, dbRow, deployment };
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
  dbHolder.current = null;
});

describe('Phase 3-6 SOFTWARE runtime hermetic dry-run', () => {
  // ========================================================================
  // HAPPY PATH — deployed → gate → live; runtime row created;
  // build → running.
  // ========================================================================
  it('happy path: deployed → gate → "running"; kind=software runtime created; ZERO runs spawned', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedDeployedSoftware(db, { buildStatus: 'deployed' });

    const res = await softwareActivatePOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      kind: string;
      runtime_id: string;
      deploy_url: string | null;
    };
    expect(body.status).toBe('active');
    expect(body.kind).toBe('software');
    expect(body.runtime_id).toBeTruthy();

    // Build → 'running'.
    const afterBuild = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(afterBuild?.status).toBe('running');

    // agent_runtimes row exists, kind='software', status='active'.
    const runtimes = (db.tables.agent_runtimes ?? []) as Array<
      Record<string, unknown>
    >;
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.kind).toBe('software');
    expect(runtimes[0]?.status).toBe('active');
    expect(runtimes[0]?.mode).toBe('always_on');
    // Software runtimes don't tick — next_run_at must stay null so the
    // shared scheduler's `.lte('next_run_at', now)` query never picks
    // them up.
    expect(runtimes[0]?.next_run_at).toBeNull();
    // Env keys empty — env was wired into Vercel during deploy, not
    // stored on the runtime row.
    expect(runtimes[0]?.env_encrypted).toBeNull();

    // NO runs spawned. A software runtime is a marker, not an executor.
    expect((db.tables.runs ?? []).length).toBe(0);

    // Audit trail: authorized + activated, no failure.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(
      audit.some((r) => r.action === 'software.runtime_authorized'),
    ).toBe(true);
    expect(
      audit.some((r) => r.action === 'software.runtime_activated'),
    ).toBe(true);
  });

  // ========================================================================
  // GATE GUARDS — anything without { authorized: true } 403s.
  // ========================================================================
  it('refuses missing { authorized: true } with 403; no runtime row created', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedDeployedSoftware(db);

    const noFlag = await softwareActivatePOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(noFlag.status).toBe(403);

    const explicitFalse = await softwareActivatePOST(
      makePost({ authorized: false }),
      { params: { id: PROJECT_ID } },
    );
    expect(explicitFalse.status).toBe(403);

    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
    const reloaded = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    // Build stays at 'deployed'.
    expect(reloaded?.status).toBe('deployed');
  });

  // ========================================================================
  // STATUS GATE — go-live refuses a non-deployed build.
  // ========================================================================
  it('refuses a build still at "tested" with 409 (must be deployed first)', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSoftware(db);
    (db.tables.builds?.[0] as unknown as Build).status = 'tested';

    const res = await softwareActivatePOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
  });

  // ========================================================================
  // CONCURRENCY — refuses re-activation while a non-stopped software
  // runtime exists.
  // ========================================================================
  it('refuses re-activation when a non-stopped software runtime exists', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedDeployedSoftware(db);
    db.tables.agent_runtimes = [
      {
        id: 'rt-existing',
        project_id: PROJECT_ID,
        build_id: build.id,
        kind: 'software',
        mode: 'always_on',
        schedule_cron: '@always',
        status: 'active',
        next_run_at: null,
        last_run_at: null,
        run_count: 0,
        fail_count: 0,
        consecutive_fails: 0,
        max_run_ms: 60_000,
        env_encrypted: null,
        env_keys: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const res = await softwareActivatePOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    // Original row still there, no second row inserted.
    expect((db.tables.agent_runtimes ?? []).length).toBe(1);
  });

  // ========================================================================
  // KILL SWITCH — active project kill switch blocks go-live with
  // governance:killed.
  // ========================================================================
  it('kill switch active → go-live blocked with governance:killed (503); no runtime row created', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSoftware(db);
    db.tables.kill_switches = [
      {
        id: 'ks-1',
        scope: 'project',
        scope_id: PROJECT_ID,
        active: true,
        reason: 'budget freeze',
        set_by: FAKE_USER.id,
        created_at: new Date().toISOString(),
      },
    ];

    const res = await softwareActivatePOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      reason: string;
      detail: { scope?: string };
    };
    expect(body.reason).toBe('killed');
    expect(body.detail.scope).toBe('project');

    // No runtime created. Build stays 'deployed'.
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
  });

  // ========================================================================
  // KILL SWITCH — clearing the switch allows go-live again.
  // ========================================================================
  it('clearing the kill switch restores go-live; runtime row is created on retry', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSoftware(db);
    db.tables.kill_switches = [
      {
        id: 'ks-1',
        scope: 'project',
        scope_id: PROJECT_ID,
        active: true,
        reason: 'budget freeze',
        set_by: FAKE_USER.id,
        created_at: new Date().toISOString(),
      },
    ];

    // First attempt: refused while switch active.
    const blocked = await softwareActivatePOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(blocked.status).toBe(503);

    // Operator clears the switch (simulate by flipping active=false).
    (db.tables.kill_switches[0] as Record<string, unknown>).active = false;

    // Retry: succeeds.
    const allowed = await softwareActivatePOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(allowed.status).toBe(200);
    expect((db.tables.agent_runtimes ?? []).length).toBe(1);
  });

  // ========================================================================
  // KILL SWITCH SYNC — an active switch with an existing 'active'
  // runtime row auto-pauses the runtime on the next dashboard load.
  // ========================================================================
  it('syncSoftwareRuntimeWithKillSwitch flips an active runtime → paused when a kill switch is active', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedDeployedSoftware(db, { buildStatus: 'running' });
    db.tables.agent_runtimes = [
      {
        id: 'rt-live',
        project_id: PROJECT_ID,
        build_id: build.id,
        kind: 'software',
        mode: 'always_on',
        schedule_cron: '@always',
        status: 'active',
        next_run_at: null,
        last_run_at: null,
        run_count: 0,
        fail_count: 0,
        consecutive_fails: 0,
        max_run_ms: 60_000,
        env_encrypted: null,
        env_keys: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    db.tables.kill_switches = [
      {
        id: 'ks-1',
        scope: 'project',
        scope_id: PROJECT_ID,
        active: true,
        reason: 'budget freeze',
        set_by: FAKE_USER.id,
        created_at: new Date().toISOString(),
      },
    ];

    const supabase = makeClient(db) as unknown as ForgeSupabase;
    const runtime = await loadSoftwareRuntimeForProject(supabase, PROJECT_ID);
    expect(runtime).toBeTruthy();
    const synced = await syncSoftwareRuntimeWithKillSwitch(
      supabase,
      runtime!,
      { userId: FAKE_USER.id, projectId: PROJECT_ID },
    );
    // The sync result reflects the flip.
    expect(synced.status).toBe('paused');
    // And the DB row is persisted with the new status.
    const reloaded = (db.tables.agent_runtimes ?? []).find(
      (r) => r.id === 'rt-live',
    ) as Record<string, unknown> | undefined;
    expect(reloaded?.status).toBe('paused');
  });

  it('syncSoftwareRuntimeWithKillSwitch is a no-op when no kill switch active', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedDeployedSoftware(db, { buildStatus: 'running' });
    db.tables.agent_runtimes = [
      {
        id: 'rt-live',
        project_id: PROJECT_ID,
        build_id: build.id,
        kind: 'software',
        mode: 'always_on',
        schedule_cron: '@always',
        status: 'active',
        next_run_at: null,
        last_run_at: null,
        run_count: 0,
        fail_count: 0,
        consecutive_fails: 0,
        max_run_ms: 60_000,
        env_encrypted: null,
        env_keys: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const supabase = makeClient(db) as unknown as ForgeSupabase;
    const runtime = await loadSoftwareRuntimeForProject(supabase, PROJECT_ID);
    const synced = await syncSoftwareRuntimeWithKillSwitch(
      supabase,
      runtime!,
      { userId: FAKE_USER.id, projectId: PROJECT_ID },
    );
    expect(synced.status).toBe('active');
  });

  // ========================================================================
  // DASHBOARD PAYLOAD — assembles correctly; service-role NEVER in it.
  // ========================================================================
  it('assembleSoftwareDashboard returns the safe shape; service-role plaintext NOT in the payload anywhere', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { project, build, dbRow, deployment } = seedDeployedSoftware(db, {
      buildStatus: 'running',
    });
    db.tables.agent_runtimes = [
      {
        id: 'rt-live',
        project_id: PROJECT_ID,
        build_id: build.id,
        kind: 'software',
        mode: 'always_on',
        schedule_cron: '@always',
        status: 'active',
        next_run_at: null,
        last_run_at: null,
        run_count: 0,
        fail_count: 0,
        consecutive_fails: 0,
        max_run_ms: 60_000,
        env_encrypted: null,
        env_keys: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const supabase = makeClient(db) as unknown as ForgeSupabase;
    const kill = await activeKillSwitch(
      { userId: FAKE_USER.id, projectId: PROJECT_ID },
      supabase,
    );
    const runtime = await loadSoftwareRuntimeForProject(supabase, PROJECT_ID);

    const payload = assembleSoftwareDashboard({
      project,
      build,
      spec: CANNED_SPEC,
      runtime,
      db: dbRow,
      deployment,
      githubAccountLogin: 'forge-tester',
      vercelAccountLogin: 'forge-tester',
      killSwitch: kill
        ? {
            active: true,
            scope: kill.scope as 'global' | 'user' | 'project',
            reason: kill.reason,
          }
        : { active: false, scope: null, reason: null },
    });

    // Shape — public-safe fields populated.
    expect(payload.live).toBe(true);
    expect(payload.deploy_url).toBe('https://team-expenses.vercel.app');
    expect(payload.deployment_status).toBe('ready');
    expect(payload.repo_url).toBe('https://github.com/forge-tester/team-expenses');
    expect(payload.db?.provider_kind).toBe('managed');
    expect(payload.db?.migration_applied).toBe(true);
    expect(payload.db?.service_role_last4).toBe(RAW_SERVICE_ROLE.slice(-4));
    expect(payload.summary.goal).toBe('Team expenses tracker');
    expect(payload.summary.entities).toBe(1);
    expect(payload.cost_dimensions).toEqual([
      { label: 'hosting', detail: 'Vercel (deployed at the URL above)' },
      { label: 'database', detail: 'Supabase (managed via Forge)' },
    ]);

    // ==== SECRET HYGIENE — the RAW service-role MUST NOT appear in
    // any property, any nested field, of the dashboard payload. ====
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(RAW_SERVICE_ROLE);
    // The encrypted blob also must not leak — only last4.
    expect(serialised).not.toContain(dbRow.service_role_encrypted);

    // Type-level guarantee — the SoftwareDashboardPayload type has no
    // service-role-key field. We assert at runtime that the only
    // service-role-related field is the safe-to-display last4.
    type DbShape = NonNullable<typeof payload.db>;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _shapeCheck: keyof DbShape =
      'service_role_last4' as keyof DbShape;
    expect('service_role_encrypted' in (payload.db ?? {})).toBe(false);
  });

  it('assembleSoftwareDashboard with active kill switch surfaces "live=false"', () => {
    const { project, build, dbRow, deployment } = (() => {
      const db = createInMemoryDb();
      return seedDeployedSoftware(db, { buildStatus: 'running' });
    })();
    const payload = assembleSoftwareDashboard({
      project,
      build,
      spec: CANNED_SPEC,
      runtime: {
        id: 'rt-live',
        project_id: PROJECT_ID,
        build_id: build.id,
        kind: 'software',
        mode: 'always_on',
        schedule_cron: '@always',
        status: 'active',
        next_run_at: null,
        last_run_at: null,
        run_count: 0,
        fail_count: 0,
        consecutive_fails: 0,
        max_run_ms: 60_000,
        env_encrypted: null,
        env_keys: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      db: dbRow,
      deployment,
      githubAccountLogin: 'forge-tester',
      vercelAccountLogin: 'forge-tester',
      killSwitch: { active: true, scope: 'project', reason: 'budget freeze' },
    });
    expect(payload.live).toBe(false);
    expect(payload.kill_switch.active).toBe(true);
    expect(payload.kill_switch.scope).toBe('project');
  });

  // ========================================================================
  // MISROUTES — Phase 1 + Phase 2 runtime/activate 409 a software build.
  // ========================================================================
  it('Phase 1 runtime/activate 409s a software build with the software-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSoftware(db);

    const res = await agentActivatePOST(
      makePost({ authorized: true, cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/software build/i);
    expect(body.error).toMatch(/software\/runtime\/activate/i);
  });

  it('Phase 2 system runtime/activate 409s a software build with the software-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedDeployedSoftware(db);

    const res = await systemActivatePOST(
      makePost({ authorized: true, cron: '*/5 * * * *' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/software/i);
  });

  // ========================================================================
  // Hermeticity.
  // ========================================================================
  it('zero real fetch calls across the whole software runtime dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
