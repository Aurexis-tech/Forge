// Hermetic end-to-end dry-run — Phase 3-5a (Software) DB PROVISIONING.
//
// Companion to software-sandbox-dryrun.test.ts. That file drives the
// sandbox side and stops at 'tested'; this file picks up at 'tested'
// and exercises the DB provisioning gate:
//
//   1. seed a project + confirmed SoftwareSpec + approved software
//      plan + a software build at status='tested' with files (the
//      generated 0001_init.sql migration is one of them)
//   2. POST /software/db/provision (managed | byo) behind the
//      mandatory { authorized: true } gate
//   3. DbProvider STUBBED end-to-end — zero real fetch, zero real DB
//   4. Assert:
//      - missing/false `authorized` → 403; no DbProvider call; build
//        stays 'tested'
//      - happy managed path → build → 'provisioned'; software_databases
//        row written with migration_applied=true; service-role
//        encrypted at rest; the response NEVER carries the raw key
//      - happy byo path → user-supplied env accepted, migration
//        applied; same secret hygiene
//      - downstream still locked: no deployments / agent_runtimes
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
import { decryptSecret } from '@/lib/crypto';
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
// Boundary mocks. Set BEFORE importing the route handler.
// ---------------------------------------------------------------------------

const FAKE_USER = { id: 'user-sw-db-dry-run', email: 'test@example.com' };
const PROJECT_ID = 'project-sw-db-dry-run';

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
        status: 'tested',
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

vi.mock('@/lib/engine/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/keys')>();
  return {
    ...actual,
    userHasAnyByok: vi.fn(async () => false),
  };
});

// The DbProvider seam. We stub selectDbProvider so the route's
// downstream path uses the same uniform interface; only the
// provision() + applyMigration() outcomes are scripted per test.
vi.mock('@/lib/engine/software/db/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/software/db/select')>();
  return {
    ...actual,
    selectDbProvider: vi.fn(),
  };
});

// Connections — only the managed flow reads here. The byo flow never
// reaches this helper.
vi.mock('@/lib/engine/integrations/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/integrations/connections')>();
  return {
    ...actual,
    loadConnectionWithToken: vi.fn(),
  };
});

// Supabase — every route call routes through getServerSupabase(). We
// swap it for the in-memory client built per-test.
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

import { selectDbProvider } from '@/lib/engine/software/db/select';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import type {
  DbProvider,
  ProvisionedDb,
} from '@/lib/engine/software/db/provider';

// Import the route handler AFTER the mocks are set up.
import { POST as provisionPOST } from '@/app/api/projects/[id]/software/db/provision/route';

// ---------------------------------------------------------------------------
// Canned data — same expense-tracker shape as the sandbox dry-run, one
// generated migration file.
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
    { name: 'User', fields: [{ name: 'email', type: 'email' }] },
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

const MIGRATION_SQL =
  '-- aurexis migration\n' +
  'create table public.expense (id uuid primary key);\n' +
  'alter table public.expense enable row level security;\n';

// ---------------------------------------------------------------------------
// Seed helper — build the (project, spec, plan, build, files) chain at
// build.status='tested' with the generated migration file in place.
// ---------------------------------------------------------------------------

function seedSoftwareTested(
  db: InMemoryDb,
  buildStatus:
    | 'tested'
    | 'provisioning'
    | 'provisioned'
    | 'provision_failed' = 'tested',
): { project: Project; spec: Spec; plan: Plan; build: Build; files: BuildFile[] } {
  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: 'Team Expenses',
    status: 'plan_approved',
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-sw-db-1',
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
    id: 'plan-sw-db-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_SW_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'software',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-sw-db-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: buildStatus,
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
      content: MIGRATION_SQL,
      source: 'generated',
      bytes: MIGRATION_SQL.length,
      created_at: new Date().toISOString(),
    },
  ];

  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.build_files = files.map(
    (f) => f as unknown as Record<string, unknown>,
  );
  return { project, spec, plan, build, files };
}

// Fake DbProvider — captures provision()/applyMigration() args and
// emits scripted outcomes. The route's only seam.
function makeFakeProvider(opts: {
  kind: 'managed' | 'byo';
  provisioned?: ProvisionedDb;
  provisionError?: Error;
  migrationOk?: boolean;
  migrationError?: string;
  statementsApplied?: number;
}): {
  provider: DbProvider;
  spies: {
    provision: ReturnType<typeof vi.fn>;
    applyMigration: ReturnType<typeof vi.fn>;
  };
} {
  const defaultProvisioned: ProvisionedDb =
    opts.provisioned ??
    (opts.kind === 'managed'
      ? {
          supabaseUrl: 'https://abcdef.supabase.co',
          anonKey: 'anon-key-managed-' + 'x'.repeat(40),
          serviceRoleKey: 'service-role-managed-' + 'y'.repeat(60),
          providerProjectRef: 'abcdef',
        }
      : {
          supabaseUrl: 'https://existing-project.supabase.co',
          anonKey: 'anon-key-byo-' + 'a'.repeat(40),
          serviceRoleKey: 'service-role-byo-' + 'b'.repeat(60),
          providerProjectRef: null,
        });

  const provision = vi.fn(async () => {
    if (opts.provisionError) throw opts.provisionError;
    return defaultProvisioned;
  });
  const applyMigration = vi.fn(async () => ({
    statementsApplied: opts.statementsApplied ?? 3,
    ok: opts.migrationOk ?? true,
    error: opts.migrationError ?? null,
  }));
  return {
    provider: {
      name: 'fake-' + opts.kind,
      kind: opts.kind,
      provision,
      applyMigration,
    } as unknown as DbProvider,
    spies: { provision, applyMigration },
  };
}

function fakeSupabaseConnection() {
  return {
    row: {
      id: 'conn-sb-1',
      user_id: FAKE_USER.id,
      provider: 'supabase' as const,
      account_login: 'forge-tester',
      scopes: null,
      key_last4: null,
      created_at: new Date().toISOString(),
    },
    token: 'sbp_management_token_xxxxx',
  };
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
  vi.mocked(selectDbProvider).mockReset();
  vi.mocked(loadConnectionWithToken).mockReset();
  dbHolder.current = null;
});

describe('Phase 3-5a SOFTWARE db provisioning hermetic dry-run', () => {
  // ========================================================================
  // GATE GUARDS — anything without { authorized: true } 403s and the
  // DbProvider is NEVER constructed (no managed call, no byo call).
  // ========================================================================
  it('refuses an empty body with 403; selectDbProvider never called; build stays "tested"', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftwareTested(db, 'tested');

    const res = await provisionPOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(403);

    // The seam never fired.
    expect(vi.mocked(selectDbProvider)).toHaveBeenCalledTimes(0);

    // Build untouched — no software_databases row.
    const build = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(build?.status).toBe('tested');
    expect((db.tables.software_databases ?? []).length).toBe(0);
  });

  it('refuses { authorized: false } with 403; selectDbProvider never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftwareTested(db, 'tested');

    const res = await provisionPOST(
      makePost({ authorized: false, provider_kind: 'managed' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(403);
    expect(vi.mocked(selectDbProvider)).toHaveBeenCalledTimes(0);
    const build = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(build?.status).toBe('tested');
  });

  it('refuses a missing provider_kind with 403 even when authorized', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftwareTested(db, 'tested');

    const res = await provisionPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(403);
    expect(vi.mocked(selectDbProvider)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // HAPPY PATH (managed) — fresh Supabase project provisioned; migration
  // applied; build → 'provisioned'; service-role encrypted at rest.
  // ========================================================================
  it('happy managed path: tested → gate → provisioned; migration applied; service-role encrypted; response has NO raw key', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedSoftwareTested(db, 'tested');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(
      fakeSupabaseConnection(),
    );
    const { provider, spies } = makeFakeProvider({ kind: 'managed' });
    vi.mocked(selectDbProvider).mockReturnValue(provider);

    const RAW_SERVICE_ROLE = 'service-role-managed-' + 'y'.repeat(60);

    const res = await provisionPOST(
      makePost({
        authorized: true,
        provider_kind: 'managed',
        project_name: 'team-expenses',
        region: 'us-east-1',
      }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as {
      status: string;
      kind: string;
      statements_applied: number;
      database: {
        provider_kind: string;
        supabase_url: string;
        anon_key: string;
        service_role_last4: string;
        provider_project_ref: string | null;
        migration_applied: boolean;
      };
    };

    expect(body.status).toBe('provisioned');
    expect(body.kind).toBe('software');
    expect(body.database.provider_kind).toBe('managed');
    expect(body.database.supabase_url).toBe('https://abcdef.supabase.co');
    expect(body.database.migration_applied).toBe(true);
    expect(body.database.service_role_last4).toBe(RAW_SERVICE_ROLE.slice(-4));
    expect(body.database.provider_project_ref).toBe('abcdef');

    // === SECRET HYGIENE — the raw service-role key MUST NOT appear in
    // the response payload anywhere (any property, any string nested
    // inside the JSON). ===
    expect(bodyText).not.toContain(RAW_SERVICE_ROLE);
    // The encrypted blob also MUST NOT leak — sanitizeDbForResponse
    // strips it. The raw plaintext also can't appear under any key.
    expect(bodyText).not.toMatch(/service_role_encrypted/);

    // === Provider lifecycle: provision() + applyMigration() each once ===
    expect(spies.provision).toHaveBeenCalledTimes(1);
    expect(spies.applyMigration).toHaveBeenCalledTimes(1);

    // The applyMigration call receives the EXACT generated SQL — the
    // structural proof from P3-4 carried forward, not an LLM edit.
    const applyArgs = spies.applyMigration.mock.calls[0];
    expect(applyArgs?.[1]).toBe(MIGRATION_SQL);

    // The managed provision() received the decrypted management token.
    const provisionArgs = spies.provision.mock.calls[0]?.[0] as {
      managementToken?: string;
      projectName?: string;
      region?: string;
    };
    expect(provisionArgs?.managementToken).toBe('sbp_management_token_xxxxx');
    expect(provisionArgs?.projectName).toBe('team-expenses');
    expect(provisionArgs?.region).toBe('us-east-1');

    // === Build → 'provisioned' ===
    const afterBuild = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(afterBuild?.status).toBe('provisioned');

    // === software_databases row written + service-role encrypted ===
    const dbRows = (db.tables.software_databases ?? []) as Array<
      Record<string, unknown>
    >;
    expect(dbRows).toHaveLength(1);
    const dbRow = dbRows[0] as unknown as SoftwareDatabase;
    expect(dbRow.provider_kind).toBe('managed');
    expect(dbRow.supabase_url).toBe('https://abcdef.supabase.co');
    expect(dbRow.migration_applied).toBe(true);
    expect(dbRow.service_role_last4).toBe(RAW_SERVICE_ROLE.slice(-4));
    // The encrypted blob is NOT the raw key.
    expect(dbRow.service_role_encrypted).not.toBe(RAW_SERVICE_ROLE);
    // But IS decryptable to the raw key (proof we encrypted-then-stored,
    // not stored-in-the-clear).
    expect(decryptSecret(dbRow.service_role_encrypted)).toBe(RAW_SERVICE_ROLE);

    // === Audit trail: authorized + provisioned, no failure event ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'software.db_authorized')).toBe(true);
    expect(audit.some((r) => r.action === 'software.db_provisioned')).toBe(true);
    expect(audit.some((r) => r.action === 'software.db_failed')).toBe(false);

    // Audit detail blobs must not carry the raw service-role key.
    for (const row of audit) {
      const detail = JSON.stringify(row.detail ?? {});
      expect(detail).not.toContain(RAW_SERVICE_ROLE);
    }

    // === Downstream still closed: no deployments / agent_runtimes ===
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
  });

  // ========================================================================
  // HAPPY PATH (byo) — user-supplied env accepted, migration applied,
  // same secret hygiene.
  // ========================================================================
  it('happy byo path: user-supplied env accepted; migration applied; service-role encrypted at rest; never in response', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedSoftwareTested(db, 'tested');

    const { provider, spies } = makeFakeProvider({ kind: 'byo' });
    vi.mocked(selectDbProvider).mockReturnValue(provider);

    const BYO_URL = 'https://existing-project.supabase.co';
    const BYO_ANON = 'anon-key-byo-' + 'a'.repeat(40);
    const BYO_SERVICE_ROLE = 'service-role-byo-' + 'b'.repeat(60);

    const res = await provisionPOST(
      makePost({
        authorized: true,
        provider_kind: 'byo',
        supabase_url: BYO_URL,
        anon_key: BYO_ANON,
        service_role_key: BYO_SERVICE_ROLE,
      }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as {
      status: string;
      database: { provider_kind: string; supabase_url: string };
    };

    expect(body.status).toBe('provisioned');
    expect(body.database.provider_kind).toBe('byo');
    expect(body.database.supabase_url).toBe(BYO_URL);

    // === SECRET HYGIENE — the BYO-supplied service-role MUST NOT leak ===
    expect(bodyText).not.toContain(BYO_SERVICE_ROLE);

    // The byo flow never reads the supabase Management connection.
    expect(vi.mocked(loadConnectionWithToken)).toHaveBeenCalledTimes(0);

    // Provider lifecycle.
    expect(spies.provision).toHaveBeenCalledTimes(1);
    expect(spies.applyMigration).toHaveBeenCalledTimes(1);
    const provisionArgs = spies.provision.mock.calls[0]?.[0] as {
      byo?: {
        supabaseUrl: string;
        anonKey: string;
        serviceRoleKey: string;
      };
    };
    expect(provisionArgs?.byo?.supabaseUrl).toBe(BYO_URL);
    expect(provisionArgs?.byo?.serviceRoleKey).toBe(BYO_SERVICE_ROLE);

    // === Build → 'provisioned' + row encrypted ===
    const afterBuild = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(afterBuild?.status).toBe('provisioned');

    const dbRows = (db.tables.software_databases ?? []) as Array<
      Record<string, unknown>
    >;
    expect(dbRows).toHaveLength(1);
    const dbRow = dbRows[0] as unknown as SoftwareDatabase;
    expect(dbRow.provider_kind).toBe('byo');
    expect(dbRow.supabase_url).toBe(BYO_URL);
    expect(dbRow.provider_project_ref).toBeNull();
    expect(dbRow.service_role_last4).toBe(BYO_SERVICE_ROLE.slice(-4));
    expect(dbRow.service_role_encrypted).not.toBe(BYO_SERVICE_ROLE);
    expect(decryptSecret(dbRow.service_role_encrypted)).toBe(BYO_SERVICE_ROLE);
  });

  // ========================================================================
  // STATUS GATE — provision route refuses a 'generated' build.
  // ========================================================================
  it('refuses a build that is still "generated" with 409; selectDbProvider never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftwareTested(db, 'tested');
    (db.tables.builds?.[0] as unknown as Build).status = 'generated';

    const res = await provisionPOST(
      makePost({ authorized: true, provider_kind: 'managed' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    expect(vi.mocked(selectDbProvider)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // CONCURRENCY — a build that already has migration_applied=true cannot
  // re-provision without explicit re-teardown.
  // ========================================================================
  it('refuses to re-provision a build that already has migration_applied=true', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedSoftwareTested(db, 'tested');

    db.tables.software_databases = [
      {
        id: 'sd-existing',
        project_id: PROJECT_ID,
        build_id: build.id,
        provider_kind: 'managed',
        supabase_url: 'https://existing.supabase.co',
        anon_key: 'anon',
        service_role_encrypted: 'enc',
        service_role_last4: 'abcd',
        provider_project_ref: 'existing',
        migration_applied: true,
        created_at: new Date().toISOString(),
      },
    ];

    const res = await provisionPOST(
      makePost({ authorized: true, provider_kind: 'managed' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    expect(vi.mocked(selectDbProvider)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // MANAGED REQUIRES A CONNECTION — 412 with a clear hint if missing.
  // ========================================================================
  it('managed flow refuses with 412 when no supabase connection exists', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSoftwareTested(db, 'tested');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(null);

    const res = await provisionPOST(
      makePost({ authorized: true, provider_kind: 'managed' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(412);
    // selectDbProvider was called (route resolves it pre-connection
    // check) OR not — either way, provision() must NOT have been
    // invoked because the route bailed early.
    const calls = vi.mocked(selectDbProvider).mock.calls.length;
    if (calls > 0) {
      // The fake we'd have returned would have spies, but we never
      // mocked one here. Asserting the early bail by checking that
      // no software_databases row was written.
    }
    expect((db.tables.software_databases ?? []).length).toBe(0);
  });

  // ========================================================================
  // MIGRATION FAILURE — DB created but the migration apply errors. Row
  // lands with migration_applied=false; build → 'provision_failed'.
  // ========================================================================
  it('migration failure: row persists with migration_applied=false; build → "provision_failed"; service-role still encrypted', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedSoftwareTested(db, 'tested');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(
      fakeSupabaseConnection(),
    );
    const { provider } = makeFakeProvider({
      kind: 'managed',
      migrationOk: false,
      migrationError: 'permission denied for schema public',
    });
    vi.mocked(selectDbProvider).mockReturnValue(provider);

    const RAW_SERVICE_ROLE = 'service-role-managed-' + 'y'.repeat(60);

    const res = await provisionPOST(
      makePost({ authorized: true, provider_kind: 'managed' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(502);
    const bodyText = await res.text();
    expect(bodyText).toMatch(/migration failed/i);
    // Even on the partial-success path, the raw key must NEVER appear.
    expect(bodyText).not.toContain(RAW_SERVICE_ROLE);

    const afterBuild = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(afterBuild?.status).toBe('provision_failed');

    const dbRows = (db.tables.software_databases ?? []) as Array<
      Record<string, unknown>
    >;
    expect(dbRows).toHaveLength(1);
    const dbRow = dbRows[0] as unknown as SoftwareDatabase;
    expect(dbRow.migration_applied).toBe(false);
    // Encryption + last4 still correct on the partial row.
    expect(dbRow.service_role_encrypted).not.toBe(RAW_SERVICE_ROLE);
    expect(decryptSecret(dbRow.service_role_encrypted)).toBe(RAW_SERVICE_ROLE);

    // Audit: db_failed at apply_migration stage.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    const failed = audit.find((r) => r.action === 'software.db_failed') as
      | { detail?: { stage?: string; message?: string } }
      | undefined;
    expect(failed).toBeDefined();
    expect(failed?.detail?.stage).toBe('apply_migration');
    // The audit detail must NOT carry the raw service-role.
    for (const row of audit) {
      const detail = JSON.stringify(row.detail ?? {});
      expect(detail).not.toContain(RAW_SERVICE_ROLE);
    }
  });

  // ========================================================================
  // KIND GATE — provision route refuses an agent project with 4xx.
  // ========================================================================
  it('refuses an agent project (kind mismatch) with a 4xx; selectDbProvider never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    // Seed an agent build at status='tested'.
    db.tables.projects = [
      {
        id: PROJECT_ID,
        user_id: FAKE_USER.id,
        name: 'agent project',
        status: 'plan_approved',
        kind: 'agent',
        created_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];
    db.tables.builds = [
      {
        id: 'b-agent-x',
        project_id: PROJECT_ID,
        spec_id: 'sx',
        plan_id: 'px',
        phase: 'codegen',
        status: 'tested',
        logs: {},
        repo_url: null,
        deploy_url: null,
        kind: 'agent',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];

    const res = await provisionPOST(
      makePost({ authorized: true, provider_kind: 'managed' }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(vi.mocked(selectDbProvider)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // Hermeticity — the whole dry-run runs without one real fetch.
  // ========================================================================
  it('zero real fetch calls across the whole software DB provision dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
