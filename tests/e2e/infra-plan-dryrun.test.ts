// Hermetic end-to-end dry-run — Phase 4-5a (Infrastructure) REAL
// TERRAFORM PLAN + DESTRUCTIVE-CONFIRM GATE.
//
// Companion to infra-preview-dryrun.test.ts. That file stops at a
// 'previewed' build (within budget). This file picks up there and
// drives the P4-5a layer:
//
//   1. PREREQUISITE — a 'generated' or 'preview_blocked' build
//      CANNOT reach plan. The plan route refuses both with 409/402.
//   2. NO CLOUD CONNECTION — 412.
//   3. PURE-CREATE plan → AuthorizationGate → { authorized: true }
//      → 'plan_confirmed'. No apply, no cloud write.
//   4. DESTRUCTIVE plan → a click WITHOUT the typed phrase is 403;
//      the EXACT typed phrase passes server-side verification and
//      reaches 'plan_confirmed'. Destroyed/replaced resources are
//      surfaced.
//   5. COST RE-CHECK — a real plan whose cost exceeds the ceiling
//      → 402 (even though P4-4 was within budget); audit
//      `infra.plan_over_budget`; build → 'plan_blocked'.
//   6. The CloudProvider seam is STUBBED end-to-end — no real
//      terraform invocation, no real cloud call. The audit detail
//      records `terraform_apply_invoked: false`, `cloud_write_count:
//      0` so the boundary is auditable.
//   7. Zero real fetch (tests/setup.ts installs fetch as a throwing
//      mock).
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Budget,
  Build,
  BuildFile,
  InfraPlan,
  InfraPreview,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { encryptSecret } from '@/lib/crypto';
import {
  InfraSpecSchema,
  type InfraSpec,
} from '@/lib/engine/infra/spec';
import {
  ProvisioningPlanSchema,
  type ProvisioningPlan,
} from '@/lib/engine/infra/planner/schema';
import { deriveInfraGraph } from '@/lib/engine/infra/planner/graph';
import { deriveInfraPreview } from '@/lib/engine/infra/preview/derive';
import type {
  CloudProvider,
  InfraPlanDiff,
  PlannedResource,
} from '@/lib/engine/infra/cloud/provider';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Boundary mocks. Set BEFORE importing the route handlers.
// ---------------------------------------------------------------------------

const FAKE_USER = { id: 'user-infra-plan-dry-run', email: 'test@example.com' };
const PROJECT_ID = 'project-infra-plan-dry-run';
const PROJECT_NAME = 'Ingest Pipeline';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    requireUser: vi.fn(async () => FAKE_USER),
    requireProjectOwnership: vi.fn(async (id: string) => ({
      project: {
        id,
        user_id: FAKE_USER.id,
        name: PROJECT_NAME,
        status: 'previewed',
        kind: 'infrastructure',
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

// The CloudProvider seam — STUBBED end-to-end. The route's call to
// selectCloudProvider() resolves through this mock; the real
// TerraformCliProvider is never instantiated, no `terraform`
// binary is spawned, no real cloud call fires.
vi.mock('@/lib/engine/infra/cloud/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/infra/cloud/select')>();
  return {
    ...actual,
    selectCloudProvider: vi.fn(),
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
import { POST as planPOST } from '@/app/api/projects/[id]/infra/build/plan/route';
import { POST as confirmPOST } from '@/app/api/projects/[id]/infra/build/confirm-plan/route';
import { selectCloudProvider } from '@/lib/engine/infra/cloud/select';

// ---------------------------------------------------------------------------
// Canned data.
// ---------------------------------------------------------------------------

const CANNED_INFRA_SPEC: InfraSpec = InfraSpecSchema.parse({
  goal: 'Ingest pipeline + small public API.',
  region: 'us-east-1',
  lifecycle: 'persistent',
  resources: [
    {
      id: 'events_db',
      type: 'postgres_db',
      config: { version: '15', storage_gb: 40 },
    },
    {
      id: 'event_archive',
      type: 'object_store',
      config: { lifecycle_days: 60 },
    },
    {
      id: 'ingest_worker',
      type: 'worker',
      config: { image: 'aurexis/ingest:1.0.0' },
      sizing: { instances: 2 },
    },
    {
      id: 'public_api',
      type: 'http_service',
      config: { image: 'aurexis/api:1.0.0', public: true },
      sizing: { instances: 1 },
    },
  ],
  topology: [
    { from: 'ingest_worker', to: 'events_db' },
    { from: 'ingest_worker', to: 'event_archive' },
    { from: 'public_api', to: 'events_db' },
  ],
});

const DERIVED = deriveInfraGraph(CANNED_INFRA_SPEC);
const CANNED_INFRA_PLAN: ProvisioningPlan = ProvisioningPlanSchema.parse({
  catalog_version: 'v1',
  steps: DERIVED.steps.map((s) => ({
    id: s.id,
    layer: s.layer,
    module: s.module,
    description: s.description,
    depends_on: s.depends_on,
    config: s.config,
    resource_id: s.resource_id,
    secure_defaults: s.secure_defaults,
  })),
  execution_order: DERIVED.executionOrder,
  warnings: [],
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function seedPreviewedInfra(db: InMemoryDb, opts: {
  buildStatus?:
    | 'generated'
    | 'previewed'
    | 'preview_blocked'
    | 'planning'
    | 'plan_blocked'
    | 'plan_confirmed';
  previewVerdict?: 'within_budget' | 'over_budget' | 'no_budget_set';
  // The estimated cost the preview row carries. The cost re-check
  // tests compare against this number when seeding budgets.
  monthlyUsd?: number;
} = {}): {
  project: Project;
  build: Build;
  preview: InfraPreview;
} {
  const buildStatus = opts.buildStatus ?? 'previewed';
  const previewVerdict = opts.previewVerdict ?? 'within_budget';
  const monthlyUsd = opts.monthlyUsd ?? 100;

  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: PROJECT_NAME,
    status: 'previewed',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-infra-plan-1',
    project_id: project.id,
    raw_prompt: 'ingest pipeline',
    structured_spec:
      CANNED_INFRA_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'confirmed',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const plan: Plan = {
    id: 'plan-infra-plan-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_INFRA_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-infra-plan-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: buildStatus,
    logs: { static_checks: [], warnings: [] } as unknown as Build['logs'],
    repo_url: null,
    deploy_url: null,
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const files: BuildFile[] = [
    {
      id: 'f-versions',
      build_id: build.id,
      path: 'infra/versions.tf',
      content: '# === aurexis-forge ===\n',
      source: 'scaffold',
      bytes: 30,
      created_at: new Date().toISOString(),
    },
    {
      id: 'f-network',
      build_id: build.id,
      path: 'infra/network/network_private_subnets.tf',
      content:
        '# === aurexis-forge ===\nmodule "network_private_subnets" {\n  source = "aurexis-forge/private-network/composable"\n}\n',
      source: 'scaffold',
      bytes: 100,
      created_at: new Date().toISOString(),
    },
  ];
  const previewSnapshot = deriveInfraPreview({
    plan: CANNED_INFRA_PLAN,
    publicHttpServiceResourceIds: ['public_api'],
  });
  const preview: InfraPreview = {
    id: 'pv-1',
    project_id: project.id,
    build_id: build.id,
    estimated_usd_per_month: monthlyUsd,
    estimated_usd_per_hour: monthlyUsd / 730,
    ceiling_verdict: previewVerdict,
    ceiling_period: previewVerdict === 'no_budget_set' ? null : 'monthly',
    ceiling_limit_usd:
      previewVerdict === 'within_budget' ? monthlyUsd * 4 : null,
    ceiling_projected_usd:
      previewVerdict === 'no_budget_set' ? null : monthlyUsd,
    preview:
      previewSnapshot as unknown as InfraPreview['preview'],
    ceiling_message:
      previewVerdict === 'over_budget'
        ? 'estimated over the cap'
        : 'within your ceiling',
    created_at: new Date().toISOString(),
  };

  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.build_files = files.map(
    (f) => f as unknown as Record<string, unknown>,
  );
  db.tables.infra_previews = [preview as unknown as Record<string, unknown>];
  return { project, build, preview };
}

function seedCloudConnection(db: InMemoryDb) {
  const envBag = {
    AWS_ACCESS_KEY_ID: 'AKIAFAKE000000000000',
    AWS_SECRET_ACCESS_KEY: 'secret-not-a-real-key',
    AWS_REGION: 'us-east-1',
  };
  const tokenEncrypted = encryptSecret(JSON.stringify(envBag));
  const row = {
    id: 'conn-cloud-1',
    user_id: FAKE_USER.id,
    provider: 'cloud',
    account_login: 'aws-us-east-1',
    token_encrypted: tokenEncrypted,
    scopes: null,
    key_last4: null,
    created_at: new Date().toISOString(),
  };
  db.tables.connections = [row as unknown as Record<string, unknown>];
}

function seedBudget(db: InMemoryDb, limit_usd: number) {
  const row = {
    id: 'budget-1',
    user_id: FAKE_USER.id,
    period: 'monthly',
    limit_usd,
    hard_cap: true,
    display_currency: 'USD',
    created_at: new Date().toISOString(),
  };
  db.tables.budgets = [row as unknown as Record<string, unknown>];
}

function makePost(body?: unknown): Request {
  return new Request('http://test/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function res(action: PlannedResource['action'], address: string, type: string): PlannedResource {
  // Module id == first address segment if it's `module.<id>.`.
  const m = /^module\.([a-z][a-z0-9_]*)\./.exec(address);
  return {
    address,
    type,
    module: m ? m[1] ?? null : null,
    action,
  };
}

function makeStubProvider(diff: InfraPlanDiff): {
  provider: CloudProvider;
  planSpy: ReturnType<typeof vi.fn>;
} {
  const planSpy = vi.fn(async () => ({
    diff,
    plan_artifact_b64: 'fake-plan-artifact-base64',
  }));
  return {
    provider: {
      name: 'stub',
      kind: 'terraform_cli',
      plan: planSpy,
    } as unknown as CloudProvider,
    planSpy,
  };
}

function pureCreateDiff(): InfraPlanDiff {
  const resources = [
    res('create', 'module.network_private_subnets.aws_vpc.this', 'aws_vpc'),
    res(
      'create',
      'module.data_events_db.aws_db_instance.this',
      'aws_db_instance',
    ),
    res(
      'create',
      'module.compute_ingest_worker.aws_ecs_service.this',
      'aws_ecs_service',
    ),
  ];
  return {
    resources,
    create_count: 3,
    change_count: 0,
    replace_count: 0,
    destroy_count: 0,
    destructive: false,
    terraform_version: '1.6.0',
    provider_metadata: ['aws@5.30'],
  };
}

function destructiveDiff(): InfraPlanDiff {
  const resources = [
    res('create', 'module.network_private_subnets.aws_vpc.this', 'aws_vpc'),
    res(
      'destroy',
      'module.data_events_db.aws_db_instance.this',
      'aws_db_instance',
    ),
    res(
      'replace',
      'module.compute_ingest_worker.aws_ecs_service.this',
      'aws_ecs_service',
    ),
    res(
      'change',
      'module.observability_pipeline.aws_cloudwatch_log_group.this',
      'aws_cloudwatch_log_group',
    ),
  ];
  return {
    resources,
    create_count: 1,
    change_count: 1,
    replace_count: 1,
    destroy_count: 1,
    destructive: true,
    terraform_version: '1.6.0',
    provider_metadata: [],
  };
}

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(selectCloudProvider).mockReset();
  dbHolder.current = null;
});

describe('Phase 4-5a INFRA plan + destructive-confirm gate hermetic dry-run', () => {
  // ========================================================================
  // PREREQUISITE — only a within-budget 'previewed' build reaches plan.
  // ========================================================================
  it('refuses a "generated" build with 409 (run the preview first)', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedPreviewedInfra(db, { buildStatus: 'generated' });
    seedCloudConnection(db);

    const r = await planPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(409);
    expect(vi.mocked(selectCloudProvider)).toHaveBeenCalledTimes(0);
    expect((db.tables.infra_plans ?? []).length).toBe(0);
  });

  it('refuses a "preview_blocked" build with 402 (raise ceiling + re-preview first)', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedPreviewedInfra(db, {
      buildStatus: 'preview_blocked',
      previewVerdict: 'over_budget',
    });
    seedCloudConnection(db);

    const r = await planPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(402);
    expect(vi.mocked(selectCloudProvider)).toHaveBeenCalledTimes(0);
    expect((db.tables.infra_plans ?? []).length).toBe(0);
  });

  // ========================================================================
  // CONNECTION — 412 when no cloud connection is configured.
  // ========================================================================
  it('refuses with 412 when no cloud connection is configured', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedPreviewedInfra(db);

    const r = await planPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(412);
    expect(vi.mocked(selectCloudProvider)).toHaveBeenCalledTimes(0);
    expect((db.tables.infra_plans ?? []).length).toBe(0);
  });

  // ========================================================================
  // PURE-CREATE plan → AuthorizationGate → plan_confirmed.
  // ========================================================================
  it('happy pure-create path: stubbed plan → AuthorizationGate → "plan_confirmed"; no apply', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedPreviewedInfra(db);
    seedCloudConnection(db);
    seedBudget(db, 10_000); // way above any plan cost
    const { provider, planSpy } = makeStubProvider(pureCreateDiff());
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    // --- /plan ---
    const planRes = await planPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(planRes.status).toBe(200);
    const planBody = (await planRes.json()) as {
      status: string;
      plan: {
        destructive: boolean;
        typed_phrase_required: string | null;
      };
      terraform_apply_invoked: boolean;
      cloud_write_count: number;
    };
    expect(planBody.status).toBe('planned');
    expect(planBody.plan.destructive).toBe(false);
    expect(planBody.plan.typed_phrase_required).toBeNull();
    // Boundary markers.
    expect(planBody.terraform_apply_invoked).toBe(false);
    expect(planBody.cloud_write_count).toBe(0);

    // CloudProvider called exactly once, with credentials decrypted
    // from the stored connection.
    expect(planSpy).toHaveBeenCalledTimes(1);
    const planArgs = planSpy.mock.calls[0]?.[0] as {
      credentials: { env: Record<string, string>; account_hint: string | null };
    };
    expect(planArgs.credentials.env.AWS_ACCESS_KEY_ID).toBe(
      'AKIAFAKE000000000000',
    );
    expect(planArgs.credentials.account_hint).toBe('aws-us-east-1');

    // --- /confirm-plan with { authorized: true } only ---
    const confRes = await confirmPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(confRes.status).toBe(200);
    const confBody = (await confRes.json()) as {
      status: string;
      destructive: boolean;
      terraform_apply_invoked: boolean;
      cloud_write_count: number;
    };
    expect(confBody.status).toBe('plan_confirmed');
    expect(confBody.destructive).toBe(false);
    expect(confBody.terraform_apply_invoked).toBe(false);
    expect(confBody.cloud_write_count).toBe(0);

    // Build → 'plan_confirmed'; plan row stamped with confirmed_by +
    // typed_phrase_verified=true (vacuously for pure-create).
    const reloaded = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(reloaded?.status).toBe('plan_confirmed');
    const planRow = (db.tables.infra_plans ?? [])[0] as
      | InfraPlan
      | undefined;
    expect(planRow?.confirmed_by_user_id).toBe(FAKE_USER.id);
    expect(planRow?.typed_phrase_verified).toBe(true);

    // Audit: plan_started + plan_completed + plan_confirmed; NO
    // destructive_confirm_required (pure-create); NO plan_over_budget.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'infra.plan_started')).toBe(true);
    expect(audit.some((r) => r.action === 'infra.plan_completed')).toBe(true);
    expect(audit.some((r) => r.action === 'infra.plan_confirmed')).toBe(true);
    expect(
      audit.some((r) => r.action === 'infra.destructive_confirm_required'),
    ).toBe(false);
    expect(audit.some((r) => r.action === 'infra.plan_over_budget')).toBe(
      false,
    );
    // Every audit row carries the boundary markers.
    for (const row of audit) {
      const detail = (row.detail as Record<string, unknown>) ?? {};
      if (
        row.action === 'infra.plan_started' ||
        row.action === 'infra.plan_completed' ||
        row.action === 'infra.plan_confirmed'
      ) {
        expect(detail.terraform_apply_invoked).toBe(false);
        expect(detail.cloud_write_count).toBe(0);
      }
    }
  });

  // ========================================================================
  // DESTRUCTIVE plan → click insufficient; typed confirm required.
  // ========================================================================
  it('destructive plan: click WITHOUT typed phrase is 403; the exact typed phrase passes', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedPreviewedInfra(db);
    seedCloudConnection(db);
    seedBudget(db, 10_000);
    const { provider } = makeStubProvider(destructiveDiff());
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const planRes = await planPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(planRes.status).toBe(200);
    const planBody = (await planRes.json()) as {
      plan: {
        destructive: boolean;
        typed_phrase_required: string | null;
        destroy_count: number;
        change_count: number;
      };
    };
    expect(planBody.plan.destructive).toBe(true);
    // The phrase is derived from the project name: `DESTROY <slug>`.
    expect(planBody.plan.typed_phrase_required).toBe('DESTROY ingest-pipeline');
    // destroy + replace collapse into the persisted destroy_count.
    expect(planBody.plan.destroy_count).toBe(2);
    expect(planBody.plan.change_count).toBe(1);

    // Audit: destructive_confirm_required emitted.
    const auditAfterPlan = (db.tables.audit_log ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      auditAfterPlan.some(
        (r) => r.action === 'infra.destructive_confirm_required',
      ),
    ).toBe(true);

    // === CLICK WITHOUT TYPED PHRASE → 403 ===
    const noPhrase = await confirmPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(noPhrase.status).toBe(403);
    const noPhraseBody = (await noPhrase.json()) as {
      error?: string;
      typed_phrase_required?: string;
      destroy_count?: number;
    };
    expect(noPhraseBody.error).toMatch(/typed_confirm/i);
    expect(noPhraseBody.typed_phrase_required).toBe('DESTROY ingest-pipeline');
    // The destructive resources are surfaced so the client can
    // render the "this will destroy/replace: ..." warning.
    expect(noPhraseBody.destroy_count).toBe(2);

    // Build stays NOT-CONFIRMED.
    let buildRow = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(buildRow?.status).not.toBe('plan_confirmed');

    // === WRONG TYPED PHRASE → 403 ===
    const wrong = await confirmPOST(
      makePost({ authorized: true, typed_confirm: 'DESTROY wrong-slug' }),
      { params: { id: PROJECT_ID } },
    );
    expect(wrong.status).toBe(403);
    buildRow = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(buildRow?.status).not.toBe('plan_confirmed');

    // === EXACT TYPED PHRASE → passes ===
    const ok = await confirmPOST(
      makePost({
        authorized: true,
        typed_confirm: 'DESTROY ingest-pipeline',
      }),
      { params: { id: PROJECT_ID } },
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as {
      status: string;
      destructive: boolean;
      terraform_apply_invoked: boolean;
      cloud_write_count: number;
    };
    expect(okBody.status).toBe('plan_confirmed');
    expect(okBody.destructive).toBe(true);
    expect(okBody.terraform_apply_invoked).toBe(false);
    expect(okBody.cloud_write_count).toBe(0);

    buildRow = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(buildRow?.status).toBe('plan_confirmed');
    const planRow = (db.tables.infra_plans ?? [])[0] as
      | InfraPlan
      | undefined;
    expect(planRow?.destructive).toBe(true);
    expect(planRow?.typed_phrase_verified).toBe(true);
    expect(planRow?.confirmed_by_user_id).toBe(FAKE_USER.id);

    // Audit: plan_confirmed present, destructive=true.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    const confirmed = audit.find(
      (r) => r.action === 'infra.plan_confirmed',
    ) as { detail?: Record<string, unknown> } | undefined;
    expect(confirmed).toBeDefined();
    expect(confirmed?.detail?.destructive).toBe(true);
    expect(confirmed?.detail?.typed_phrase_verified).toBe(true);
    expect(confirmed?.detail?.terraform_apply_invoked).toBe(false);
    expect(confirmed?.detail?.cloud_write_count).toBe(0);
  });

  // ========================================================================
  // COST RE-CHECK — real plan over the ceiling → 402; even though P4-4
  // passed within budget.
  // ========================================================================
  it('real-plan cost re-check: real plan over the ceiling → 402; build → "plan_blocked"; audit infra.plan_over_budget', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedPreviewedInfra(db);
    seedCloudConnection(db);
    // Set a tiny cap — anything the real plan costs will exceed it.
    seedBudget(db, 1);
    // Stub a plan WITH significant resources (the cost-recheck
    // attributes positive monthly USD even with one db + one worker).
    const { provider } = makeStubProvider({
      resources: [
        res(
          'create',
          'module.data_events_db.aws_db_instance.this',
          'aws_db_instance',
        ),
        res(
          'create',
          'module.compute_ingest_worker.aws_ecs_service.this',
          'aws_ecs_service',
        ),
      ],
      create_count: 2,
      change_count: 0,
      replace_count: 0,
      destroy_count: 0,
      destructive: false,
      terraform_version: '1.6.0',
      provider_metadata: [],
    });
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await planPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(402);
    const body = (await r.json()) as {
      status: string;
      plan: { ceiling_verdict: string; ceiling_limit_usd: number | null };
      terraform_apply_invoked: boolean;
      cloud_write_count: number;
    };
    expect(body.status).toBe('plan_blocked');
    expect(body.plan.ceiling_verdict).toBe('over_budget');
    expect(body.plan.ceiling_limit_usd).toBeCloseTo(1);
    expect(body.terraform_apply_invoked).toBe(false);
    expect(body.cloud_write_count).toBe(0);

    // Build → 'plan_blocked'; persisted row reflects verdict.
    const reloaded = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(reloaded?.status).toBe('plan_blocked');
    const planRow = (db.tables.infra_plans ?? [])[0] as
      | InfraPlan
      | undefined;
    expect(planRow?.ceiling_verdict).toBe('over_budget');

    // Audit: plan_started + plan_over_budget present; plan_completed
    // NOT present (the cost-recheck blocked before the within-budget
    // path emits completed).
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'infra.plan_started')).toBe(true);
    expect(audit.some((r) => r.action === 'infra.plan_over_budget')).toBe(
      true,
    );
    expect(audit.some((r) => r.action === 'infra.plan_completed')).toBe(false);

    // === Subsequent confirm attempt is refused: the plan is
    // over-budget, the gate stays closed. ===
    const confRes = await confirmPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(confRes.status).toBe(402);
    const stillBlocked = (db.tables.builds ?? []).find(
      (r) => r.id === build.id,
    ) as Build | undefined;
    expect(stillBlocked?.status).toBe('plan_blocked');
  });

  // ========================================================================
  // NO BUDGET — preview verdict was no_budget_set; planning works,
  // ceiling verdict on the real plan is also no_budget_set; gate fires.
  // ========================================================================
  it('no hard-cap budget → real plan still runs; verdict no_budget_set; gate fires', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedPreviewedInfra(db, { previewVerdict: 'no_budget_set' });
    seedCloudConnection(db);
    const { provider } = makeStubProvider(pureCreateDiff());
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await planPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      plan: { ceiling_verdict: string };
    };
    expect(body.plan.ceiling_verdict).toBe('no_budget_set');

    // The confirm step works the same way.
    const conf = await confirmPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(conf.status).toBe(200);
  });

  // ========================================================================
  // CONFIRM-PLAN preconditions.
  // ========================================================================
  it('confirm-plan refuses with 409 when no plan row exists', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedPreviewedInfra(db);
    // No infra_plans row.

    const r = await confirmPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(r.status).toBe(409);
  });

  it('confirm-plan refuses with 403 when body lacks authorized:true', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedPreviewedInfra(db);
    seedCloudConnection(db);
    seedBudget(db, 10_000);
    const { provider } = makeStubProvider(pureCreateDiff());
    vi.mocked(selectCloudProvider).mockReturnValue(provider);
    await planPOST(makePost(), { params: { id: PROJECT_ID } });

    const noAuth = await confirmPOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(noAuth.status).toBe(403);
    const falseAuth = await confirmPOST(
      makePost({ authorized: false }),
      { params: { id: PROJECT_ID } },
    );
    expect(falseAuth.status).toBe(403);
  });

  // ========================================================================
  // PROVIDER FAILURE — terraform plan errored: route 502s; build is
  // rolled back to 'previewed' so a retry can fire.
  // ========================================================================
  it('cloud provider error: build rolls back to "previewed"; no plan row persisted', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedPreviewedInfra(db);
    seedCloudConnection(db);
    const planSpy = vi.fn(async () => {
      throw new Error('terraform init failed: missing provider');
    });
    vi.mocked(selectCloudProvider).mockReturnValue({
      name: 'stub-fail',
      kind: 'terraform_cli',
      plan: planSpy,
    } as unknown as CloudProvider);

    const r = await planPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(502);
    const reloaded = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(reloaded?.status).toBe('previewed');
    expect((db.tables.infra_plans ?? []).length).toBe(0);
    // Audit: plan_started + plan_failed; NO plan_completed.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'infra.plan_started')).toBe(true);
    expect(audit.some((r) => r.action === 'infra.plan_failed')).toBe(true);
    expect(audit.some((r) => r.action === 'infra.plan_completed')).toBe(false);
  });

  // ========================================================================
  // SECRET HYGIENE — the audit-log details and the response body
  // must NEVER carry the raw cloud credentials (the env bag JSON
  // blob).
  // ========================================================================
  it('audit log + response NEVER carry the raw cloud credentials', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedPreviewedInfra(db);
    seedCloudConnection(db);
    seedBudget(db, 10_000);
    const { provider } = makeStubProvider(pureCreateDiff());
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const planRes = await planPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    const planBody = await planRes.text();
    expect(planBody).not.toContain('AKIAFAKE000000000000');
    expect(planBody).not.toContain('secret-not-a-real-key');

    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    for (const row of audit) {
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain('AKIAFAKE000000000000');
      expect(serialised).not.toContain('secret-not-a-real-key');
    }
  });

  // ========================================================================
  // HERMETICITY — zero real fetch across the whole dry-run.
  // ========================================================================
  it('zero real fetch calls across the whole infra plan dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
