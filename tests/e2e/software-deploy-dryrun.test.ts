// Hermetic end-to-end dry-run — Phase 3-5b (Software) PUSH + DEPLOY.
//
// Companion to software-db-provision-dryrun.test.ts. That file drives
// the DB-provisioning step and stops at 'provisioned'; this file
// picks up at 'provisioned' and exercises:
//
//   1. POST /software/build/push with { authorized: true }
//      → REUSES Phase 1 pushBuildToGitHub (STUBBED); build → 'pushed'
//   2. POST /software/build/deploy with { authorized: true, secrets? }
//      → REUSES Phase 1 deployBuildToVercel (STUBBED); build → 'deployed'
//   3. ENV-WIRING security assertions on the Vercel call:
//      - NEXT_PUBLIC_SUPABASE_URL is PUBLIC (secret=false)
//      - NEXT_PUBLIC_SUPABASE_ANON_KEY is PUBLIC (secret=false)
//      - SUPABASE_SERVICE_ROLE_KEY is SERVER-ONLY (secret=true)
//      - the raw service-role NEVER appears with a NEXT_PUBLIC_ key
//      - the raw service-role NEVER appears in the response body,
//        audit_log detail, or anywhere in the deployments row
//   4. STOP: software runtime stays closed for kind='software'
//      (no agent_runtimes row, no runs row)
//   5. BOTH gates required (push gate + deploy gate)
//   6. Misroute: Phase 1/2 push + deploy routes 409 a software build
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Build,
  BuildFile,
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
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Module-level boundary mocks. Set BEFORE importing the route handlers.
// ---------------------------------------------------------------------------

const FAKE_USER = { id: 'user-sw-deploy-dry-run', email: 'test@example.com' };
const PROJECT_ID = 'project-sw-deploy-dry-run';

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
        status: 'provisioned',
        kind: 'software',
        created_at: new Date().toISOString(),
      } as Project,
    })),
  };
});

vi.mock('@/lib/engine/governance/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/guard')>();
  return {
    ...actual,
    assertAllowed: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/engine/integrations/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/integrations/github')>();
  return {
    ...actual,
    pushBuildToGitHub: vi.fn(),
  };
});

vi.mock('@/lib/engine/integrations/vercel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/integrations/vercel')>();
  return {
    ...actual,
    deployBuildToVercel: vi.fn(),
  };
});

vi.mock('@/lib/engine/integrations/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/integrations/connections')>();
  return {
    ...actual,
    loadConnectionWithToken: vi.fn(),
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

// The LIVE pre-deploy isolation probe hits real Supabase Auth + Storage — mock
// it (like deployBuildToVercel) so the dry-run stays hermetic. Default is a
// passing (vacuous) verdict; blocking tests override per-case. The PURE verdict
// logic is unit-tested separately in software-storage-isolation.test.ts.
vi.mock('@/lib/engine/software/sandbox/storage-isolation-live', () => ({
  runPreDeployIsolationProbes: vi.fn(),
}));

import { pushBuildToGitHub } from '@/lib/engine/integrations/github';
import {
  deployBuildToVercel,
  type VercelEnvVar,
} from '@/lib/engine/integrations/vercel';
import {
  loadConnectionWithToken,
  type ConnectionPublic,
} from '@/lib/engine/integrations/connections';
import { runPreDeployIsolationProbes } from '@/lib/engine/software/sandbox/storage-isolation-live';
import {
  combineIsolationProbes,
  evaluateAdminProbe,
  evaluateStorageProbe,
  type PreDeployIsolationResult,
} from '@/lib/engine/software/sandbox/storage-isolation';

// --- Isolation-probe verdict builders (use the REAL pure verdict logic) -----
function passingIsolation(): PreDeployIsolationResult {
  return combineIsolationProbes(
    evaluateStorageProbe({ ran: false, setupError: null, aReadOwn: 'denied', bReadA: 'denied', aReadB: 'denied' }),
    evaluateAdminProbe({ ran: false, setupError: null, nonAdminReadOther: 'denied', spoofedReadOther: 'denied', adminReadOther: 'allowed' }),
  );
}
function storageLeakIsolation(): PreDeployIsolationResult {
  return combineIsolationProbes(
    evaluateStorageProbe({ ran: true, setupError: null, aReadOwn: 'allowed', bReadA: 'allowed', aReadB: 'denied' }),
    evaluateAdminProbe({ ran: false, setupError: null, nonAdminReadOther: 'denied', spoofedReadOther: 'denied', adminReadOther: 'allowed' }),
  );
}
function erroredIsolation(): PreDeployIsolationResult {
  return combineIsolationProbes(
    evaluateStorageProbe({ ran: true, setupError: 'bucket missing (0002 not applied)', aReadOwn: 'error', bReadA: 'error', aReadB: 'error' }),
    evaluateAdminProbe({ ran: false, setupError: null, nonAdminReadOther: 'denied', spoofedReadOther: 'denied', adminReadOther: 'allowed' }),
  );
}

function fakeGithubConn(): { row: ConnectionPublic; token: string } {
  return {
    row: {
      id: 'conn-gh-1',
      user_id: FAKE_USER.id,
      provider: 'github',
      account_login: 'forge-tester',
      scopes: null,
      key_last4: null,
      created_at: new Date().toISOString(),
    },
    token: 'gho_test',
  };
}

function fakeVercelConn(): { row: ConnectionPublic; token: string } {
  return {
    row: {
      id: 'conn-vc-1',
      user_id: FAKE_USER.id,
      provider: 'vercel',
      account_login: 'forge-tester',
      scopes: null,
      key_last4: null,
      created_at: new Date().toISOString(),
    },
    token: 'vt_test',
  };
}

// Import the route handlers AFTER the mocks are set up.
import { POST as softwarePushPOST } from '@/app/api/projects/[id]/software/build/push/route';
import { POST as softwareDeployPOST } from '@/app/api/projects/[id]/software/build/deploy/route';
import { POST as agentPushPOST } from '@/app/api/projects/[id]/build/push/route';
import { POST as agentDeployPOST } from '@/app/api/projects/[id]/build/deploy/route';
import { POST as systemPushPOST } from '@/app/api/projects/[id]/system/build/push/route';
import { POST as systemDeployPOST } from '@/app/api/projects/[id]/system/build/deploy/route';

// ---------------------------------------------------------------------------
// Canned data — minimal software shape.
// ---------------------------------------------------------------------------

const CANNED_SOFTWARE_SPEC: SoftwareSpec = SoftwareSpecSchema.parse({
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
  ],
  execution_order: ['migration_expense'],
  warnings: [],
});

// The raw service-role plaintext the test seeds. Used everywhere we
// need to assert "this string NEVER appears in {response, audit, env
// public side}".
const RAW_SERVICE_ROLE = 'service-role-' + 'z'.repeat(80);
const RAW_ANON = 'anon-key-' + 'a'.repeat(60);
const SUPABASE_URL = 'https://abcdef.supabase.co';

// ---------------------------------------------------------------------------
// Seed helper — software (project, spec, plan, build, files,
// software_databases row) at a chosen build.status.
// ---------------------------------------------------------------------------

function seedSoftware(
  db: InMemoryDb,
  buildStatus:
    | 'provisioned'
    | 'pushing'
    | 'pushed'
    | 'push_failed'
    | 'deploying'
    | 'deployed'
    | 'deploy_failed' = 'provisioned',
  opts: { repoUrl?: string | null; deployUrl?: string | null } = {},
): {
  project: Project;
  spec: Spec;
  plan: Plan;
  build: Build;
  files: BuildFile[];
  dbRow: SoftwareDatabase;
} {
  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: 'Team Expenses',
    status: 'provisioned',
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-sw-deploy-1',
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
    id: 'plan-sw-deploy-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_SW_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-sw-deploy-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: buildStatus,
    logs: { static_checks: [], warnings: [] } as unknown as Build['logs'],
    repo_url: opts.repoUrl ?? null,
    deploy_url: opts.deployUrl ?? null,
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
      path: 'app/(app)/submit-expense/page.tsx',
      content: 'export default function P() { return null; }\n',
      source: 'generated',
      bytes: 50,
      created_at: new Date().toISOString(),
    },
  ];

  const dbRow: SoftwareDatabase = {
    id: 'sd-1',
    project_id: project.id,
    build_id: build.id,
    provider_kind: 'managed',
    supabase_url: SUPABASE_URL,
    anon_key: RAW_ANON,
    service_role_encrypted: encryptSecret(RAW_SERVICE_ROLE),
    service_role_last4: RAW_SERVICE_ROLE.slice(-4),
    provider_project_ref: 'abcdef',
    migration_applied: true,
    created_at: new Date().toISOString(),
  };

  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.build_files = files.map(
    (f) => f as unknown as Record<string, unknown>,
  );
  db.tables.software_databases = [
    dbRow as unknown as Record<string, unknown>,
  ];
  return { project, spec, plan, build, files, dbRow };
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
  vi.mocked(pushBuildToGitHub).mockReset();
  vi.mocked(deployBuildToVercel).mockReset();
  vi.mocked(loadConnectionWithToken).mockReset();
  vi.mocked(runPreDeployIsolationProbes).mockReset();
  // Default: the isolation probe passes (vacuous). Blocking tests override.
  vi.mocked(runPreDeployIsolationProbes).mockResolvedValue(passingIsolation());
  dbHolder.current = null;
});

describe('Phase 3-5b SOFTWARE push + deploy hermetic dry-run', () => {
  // ========================================================================
  // HAPPY PATH — provisioned → push (gate) → pushed → deploy (gate)
  // → deployed; env wired with security classification correct.
  // ========================================================================
  it('happy path: provisioned → push → pushed → deploy → deployed; service-role server-only; anon public; raw key never leaks', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedSoftware(db, 'provisioned');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeGithubConn());
    vi.mocked(pushBuildToGitHub).mockResolvedValue({
      repo_url: 'https://github.com/forge-tester/team-expenses',
      repo_name: 'team-expenses',
      owner: 'forge-tester',
      commit_sha: 'abc123',
      default_branch: 'main',
      files_pushed: 2,
    });

    const pushRes = await softwarePushPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(pushRes.status).toBe(200);
    const pushBody = (await pushRes.json()) as {
      status: string;
      kind: string;
      repo_url: string;
    };
    expect(pushBody.status).toBe('pushed');
    expect(pushBody.kind).toBe('software');
    expect(pushBody.repo_url).toMatch(/github\.com/);

    const afterPush = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(afterPush?.status).toBe('pushed');
    expect(afterPush?.repo_url).toBe(
      'https://github.com/forge-tester/team-expenses',
    );

    const auditAfterPush = (db.tables.audit_log ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      auditAfterPush.some((r) => r.action === 'software.push_authorized'),
    ).toBe(true);
    expect(auditAfterPush.some((r) => r.action === 'software.pushed')).toBe(
      true,
    );

    // ---- Deploy ----
    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());
    vi.mocked(deployBuildToVercel).mockResolvedValue({
      project_ref: 'prj_test',
      project_name: 'team-expenses',
      deployment_id: 'dpl_test',
      deployment_url: 'https://team-expenses.vercel.app',
      env_keys_set: [
        'NEXT_PUBLIC_SUPABASE_URL',
        'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
      ],
      ready_state: 'READY',
    });

    const deployRes = await softwareDeployPOST(
      makePost({ authorized: true }),
      { params: { id: PROJECT_ID } },
    );
    expect(deployRes.status).toBe(200);
    const deployBodyText = await deployRes.text();
    const deployBody = JSON.parse(deployBodyText) as {
      status: string;
      kind: string;
      url: string;
      env_public_keys: string[];
      env_server_only_keys: string[];
      isolation?: { outcome: string; summary: string };
    };
    expect(deployBody.status).toBe('deployed');
    expect(deployBody.kind).toBe('software');
    expect(deployBody.url).toBe('https://team-expenses.vercel.app');

    // === ENV SECURITY — examine what deployBuildToVercel actually saw ===
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(1);
    const deployArgs = vi.mocked(deployBuildToVercel).mock.calls[0]?.[0];
    expect(deployArgs).toBeDefined();
    const env: VercelEnvVar[] = deployArgs!.env;
    expect(env.length).toBeGreaterThanOrEqual(3);

    const urlEnv = env.find((e) => e.key === 'NEXT_PUBLIC_SUPABASE_URL');
    const anonEnv = env.find((e) => e.key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
    const serviceRoleEnv = env.find(
      (e) => e.key === 'SUPABASE_SERVICE_ROLE_KEY',
    );

    // Public keys land with secret=false (Vercel `type: 'plain'`)
    expect(urlEnv).toBeDefined();
    expect(urlEnv?.secret).toBe(false);
    expect(urlEnv?.value).toBe(SUPABASE_URL);

    expect(anonEnv).toBeDefined();
    expect(anonEnv?.secret).toBe(false);
    expect(anonEnv?.value).toBe(RAW_ANON);

    // Server-only secret lands with secret=true (Vercel `type: 'encrypted'`)
    expect(serviceRoleEnv).toBeDefined();
    expect(serviceRoleEnv?.secret).toBe(true);
    expect(serviceRoleEnv?.value).toBe(RAW_SERVICE_ROLE);

    // ===== HARD ASSERTION — the service-role value MUST NOT appear
    // under any NEXT_PUBLIC_* key. =====
    for (const e of env) {
      if (e.key.startsWith('NEXT_PUBLIC_')) {
        expect(e.value).not.toBe(RAW_SERVICE_ROLE);
        expect(e.value).not.toContain(RAW_SERVICE_ROLE);
      }
    }

    // ===== Response body MUST NOT contain the raw service-role. =====
    expect(deployBodyText).not.toContain(RAW_SERVICE_ROLE);
    // The response surfaces only KEY NAMES.
    expect(deployBody.env_server_only_keys).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(deployBody.env_public_keys).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(deployBody.env_public_keys).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(deployBody.env_public_keys).not.toContain('SUPABASE_SERVICE_ROLE_KEY');

    // Build → 'deployed' + deployments row → 'ready'.
    const afterDeploy = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(afterDeploy?.status).toBe('deployed');
    expect(afterDeploy?.deploy_url).toBe('https://team-expenses.vercel.app');

    const deployments = (db.tables.deployments ?? []) as Array<
      Record<string, unknown>
    >;
    expect(deployments).toHaveLength(1);
    expect(deployments[0]?.status).toBe('ready');
    // deployments.env_keys carries only KEY NAMES — assert the raw key
    // doesn't appear anywhere in the row.
    const depJson = JSON.stringify(deployments[0]);
    expect(depJson).not.toContain(RAW_SERVICE_ROLE);

    // === Audit log: full trail + NO raw service-role anywhere ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'software.deploy_authorized')).toBe(
      true,
    );
    expect(audit.some((r) => r.action === 'software.deployed')).toBe(true);
    for (const row of audit) {
      const detail = JSON.stringify(row.detail ?? {});
      expect(detail).not.toContain(RAW_SERVICE_ROLE);
    }

    // The authorisation audit row classifies env keys public vs
    // server-only — assert the service-role is on the server-only side.
    const authorisedRow = audit.find(
      (r) => r.action === 'software.deploy_authorized',
    ) as { detail?: { env_public_keys?: string[]; env_server_only_keys?: string[] } } | undefined;
    expect(authorisedRow?.detail?.env_server_only_keys).toContain(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
    expect(authorisedRow?.detail?.env_public_keys).not.toContain(
      'SUPABASE_SERVICE_ROLE_KEY',
    );

    // BOTH integration helpers fired exactly once.
    expect(vi.mocked(pushBuildToGitHub)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(1);

    // === PRE-DEPLOY ISOLATION PROBE — ran, passed, SURFACED on the response
    // + audited. (Vacuous here: the canned spec has no uploads / admin.) ===
    expect(vi.mocked(runPreDeployIsolationProbes)).toHaveBeenCalledTimes(1);
    expect(deployBody.isolation?.outcome).toBe('passed');
    expect(
      audit.some((r) => r.action === 'software.isolation_probe_passed'),
    ).toBe(true);

    // STOP — software runtime activation is NOT a Phase 3-5b entry point.
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
    expect((db.tables.runs ?? []).length).toBe(0);
  });

  // ========================================================================
  // PRE-DEPLOY ISOLATION GATE — fail-closed. A storage leak OR an unprovable
  // probe BLOCKS the deploy: Vercel is never called, the build stays 'pushed',
  // and the result is surfaced on the response + audit.
  // ========================================================================
  it('a STORAGE LEAK blocks the deploy (409); deployBuildToVercel never called; build stays pushed', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });
    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());
    vi.mocked(runPreDeployIsolationProbes).mockResolvedValue(storageLeakIsolation());

    const res = await softwareDeployPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    const body = JSON.parse(await res.text()) as {
      error: string;
      isolation?: { outcome: string; storage: { leak: { direction: string } | null } };
    };
    expect(body.error).toMatch(/isolation probe/i);
    expect(body.isolation?.outcome).toBe('failed');
    expect(body.isolation?.storage.leak).toEqual({ direction: 'b_read_a' });

    // Vercel NEVER touched; build NOT advanced.
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
    const after = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(after?.status).toBe('pushed');
    expect(after?.deploy_url).toBeNull();

    // Surfaced, not just logged — a blocked audit row exists.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(
      audit.some((r) => r.action === 'software.isolation_probe_blocked'),
    ).toBe(true);
  });

  it('an UNPROVABLE probe (errored — e.g. bucket missing) blocks the deploy fail-closed', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });
    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());
    vi.mocked(runPreDeployIsolationProbes).mockResolvedValue(erroredIsolation());

    const res = await softwareDeployPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    const body = JSON.parse(await res.text()) as { isolation?: { outcome: string } };
    expect(body.isolation?.outcome).toBe('errored');
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
    const after = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(after?.status).toBe('pushed');
  });

  it('if the probe runner THROWS, the deploy fails closed (blocked, not deployed)', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });
    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());
    vi.mocked(runPreDeployIsolationProbes).mockRejectedValue(new Error('kaboom'));

    const res = await softwareDeployPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // GATE GUARDS — both routes refuse missing { authorized: true }.
  // ========================================================================
  it('push route refuses missing { authorized: true } with 403; pushBuildToGitHub never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'provisioned');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeGithubConn());

    const noFlag = await softwarePushPOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(noFlag.status).toBe(403);

    const explicitFalse = await softwarePushPOST(
      makePost({ authorized: false }),
      { params: { id: PROJECT_ID } },
    );
    expect(explicitFalse.status).toBe(403);

    expect(vi.mocked(pushBuildToGitHub)).toHaveBeenCalledTimes(0);
    const build = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(build?.status).toBe('provisioned');
    expect(build?.repo_url).toBeNull();
  });

  it('deploy route refuses missing { authorized: true } with 403; deployBuildToVercel never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());

    const noFlag = await softwareDeployPOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(noFlag.status).toBe(403);

    const explicitFalse = await softwareDeployPOST(
      makePost({ authorized: false, secrets: {} }),
      { params: { id: PROJECT_ID } },
    );
    expect(explicitFalse.status).toBe(403);

    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
    const build = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(build?.status).toBe('pushed');
    expect(build?.deploy_url).toBeNull();
  });

  // ========================================================================
  // BODY-OVERRIDE GUARDS — user can't supply DB env keys in the body.
  // ========================================================================
  it('refuses a body that overrides SUPABASE_SERVICE_ROLE_KEY with 400; deployBuildToVercel never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });
    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());

    const res = await softwareDeployPOST(
      makePost({
        authorized: true,
        secrets: { SUPABASE_SERVICE_ROLE_KEY: 'attacker-supplied' },
      }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
  });

  it('refuses a body that overrides NEXT_PUBLIC_SUPABASE_URL with 400', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });
    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());

    const res = await softwareDeployPOST(
      makePost({
        authorized: true,
        secrets: { NEXT_PUBLIC_SUPABASE_URL: 'https://attacker.supabase.co' },
      }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // STATUS GATES — software push refuses pre-provisioned; deploy refuses
  // pre-pushed.
  // ========================================================================
  it('software push refuses a build that is still "tested" (pre-provision)', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'provisioned');
    (db.tables.builds?.[0] as unknown as Build).status = 'tested';

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeGithubConn());

    const res = await softwarePushPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    expect(vi.mocked(pushBuildToGitHub)).toHaveBeenCalledTimes(0);
  });

  it('software deploy refuses a build that has not been pushed', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'provisioned');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());

    const res = await softwareDeployPOST(
      makePost({ authorized: true }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
  });

  it('software deploy refuses when no software_databases row exists', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });
    // Drop the seeded DB row to simulate "user skipped P3-5a somehow".
    db.tables.software_databases = [];

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());

    const res = await softwareDeployPOST(
      makePost({ authorized: true }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
  });

  it('software deploy refuses when migration_applied=false on the DB row', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });
    (db.tables.software_databases?.[0] as unknown as SoftwareDatabase).migration_applied = false;

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());

    const res = await softwareDeployPOST(
      makePost({ authorized: true }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // MISROUTES — Phase 1 + 2 push/deploy 409 a software build with the
  // explicit "use the software route" hint.
  // ========================================================================
  it('Phase 1 push route 409s a software build with the software-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'provisioned');

    const res = await agentPushPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/software build/i);
    expect(body.error).toMatch(/software\/build\/push/i);
  });

  it('Phase 1 deploy route 409s a software build with the software-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });

    const res = await agentDeployPOST(
      makePost({ authorized: true, secrets: {} }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/software build/i);
    expect(body.error).toMatch(/software\/build\/deploy/i);
  });

  it('Phase 2 system push route 409s a software build with a software-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'provisioned');

    const res = await systemPushPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/software/i);
  });

  it('Phase 2 system deploy route 409s a software build with a software-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftware(db, 'pushed', {
      repoUrl: 'https://github.com/forge-tester/team-expenses',
    });

    const res = await systemDeployPOST(
      makePost({ authorized: true, secrets: {} }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/software/i);
  });

  // ========================================================================
  // Hermeticity.
  // ========================================================================
  it('zero real fetch calls across the whole software push/deploy dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
