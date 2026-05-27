// Hermetic end-to-end dry-run — Phase 4-6 (Infrastructure)
// MONITORING + DRIFT + FREEZE.
//
// Companion to infra-apply-dryrun.test.ts. That file stops at a
// 'provisioned' build. This one picks up there and drives the
// monitor surface:
//
//   1. assembleInfraDashboard reads ONLY the sanitised apply row +
//      drift check + ledger spend + kill-switch snapshot. The
//      encrypted state is NEVER in the payload (asserted by
//      serialising the payload and grepping for the raw state).
//   2. Secret-named output keys ('password', 'secret', etc.) are
//      masked.
//   3. /infra/runtime/check-drift reuses the CloudProvider.plan()
//      seam (stubbed end-to-end) and classifies in_sync vs drifted.
//      NO apply / cloud write — audit row records
//      terraform_apply_invoked: false + cloud_write_count: 0.
//   4. KILL SWITCH = FREEZE — an active project-scope switch
//      blocks /apply, /destroy, /check-drift (all via assertAllowed
//      → 503 governance:killed) and NEVER auto-destroys. Clearing
//      unfreezes.
//   5. Teardown REUSES the existing /infra/build/destroy gate.
//   6. Zero real fetch.
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Build,
  BuildFile,
  InfraApply,
  InfraDriftCheck,
  InfraPlan,
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
import type {
  CloudProvider,
  InfraPlanDiff,
} from '@/lib/engine/infra/cloud/provider';
import {
  assembleInfraDashboard,
} from '@/lib/engine/infra/runtime/persistence';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Boundary mocks.
// ---------------------------------------------------------------------------

const FAKE_USER = { id: 'user-infra-monitor-dry-run', email: 'test@example.com' };
const PROJECT_ID = 'project-infra-monitor-dry-run';
const PROJECT_NAME = 'Standing Pipeline';
const RAW_STATE = JSON.stringify({
  resources: [{ type: 'aws_db_instance' }],
  outputs: { password: { value: 'super-secret-rds-master' } },
});

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
        status: 'provisioned',
        kind: 'infrastructure',
        created_at: new Date().toISOString(),
      } as Project,
    })),
  };
});

vi.mock('@/lib/engine/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/keys')>();
  return { ...actual, userHasAnyByok: vi.fn(async () => false) };
});

vi.mock('@/lib/engine/infra/cloud/select', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/engine/infra/cloud/select')
  >();
  return { ...actual, selectCloudProvider: vi.fn() };
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

import { POST as checkDriftPOST } from '@/app/api/projects/[id]/infra/runtime/check-drift/route';
import { POST as applyPOST } from '@/app/api/projects/[id]/infra/build/apply/route';
import { POST as destroyPOST } from '@/app/api/projects/[id]/infra/build/destroy/route';
import { selectCloudProvider } from '@/lib/engine/infra/cloud/select';

// ---------------------------------------------------------------------------
// Canned data.
// ---------------------------------------------------------------------------

const CANNED_INFRA_SPEC: InfraSpec = InfraSpecSchema.parse({
  goal: 'Standing pipeline + small ephemeral side-bucket.',
  region: 'us-east-1',
  lifecycle: 'ephemeral',
  resources: [
    {
      id: 'events_db',
      type: 'postgres_db',
      config: { version: '15', storage_gb: 40 },
    },
  ],
  topology: [],
});

const DERIVED = deriveInfraGraph(CANNED_INFRA_SPEC);
const CANNED_PROVISIONING_PLAN: ProvisioningPlan =
  ProvisioningPlanSchema.parse({
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
// Seed helpers.
// ---------------------------------------------------------------------------

function seedProvisionedInfra(db: InMemoryDb): {
  project: Project;
  build: Build;
  apply: InfraApply;
  infraPlan: InfraPlan;
} {
  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: PROJECT_NAME,
    status: 'provisioned',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-infra-monitor-1',
    project_id: project.id,
    raw_prompt: 'pipeline',
    structured_spec:
      CANNED_INFRA_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'confirmed',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const plan: Plan = {
    id: 'plan-infra-monitor-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_PROVISIONING_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-infra-monitor-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: 'provisioned',
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
  ];
  const infraPlan: InfraPlan = {
    id: 'infraplan-1',
    project_id: project.id,
    build_id: build.id,
    plan_diff: {
      resources: [],
      create_count: 0,
      change_count: 0,
      replace_count: 0,
      destroy_count: 0,
      destructive: false,
      terraform_version: '1.6.0',
      provider_metadata: [],
    } as unknown as InfraPlan['plan_diff'],
    destructive: false,
    create_count: 1,
    change_count: 0,
    destroy_count: 0,
    ceiling_verdict: 'within_budget',
    ceiling_period: 'monthly',
    ceiling_limit_usd: 1000,
    ceiling_projected_usd: 100,
    ceiling_message: 'within budget',
    confirmed_by_user_id: FAKE_USER.id,
    typed_phrase_required: 'DESTROY standing-pipeline',
    typed_phrase_verified: true,
    confirmed_at: new Date().toISOString(),
    plan_artifact_b64: 'fake-artifact',
    created_at: new Date().toISOString(),
  };
  const apply: InfraApply = {
    id: 'apply-1',
    project_id: project.id,
    build_id: build.id,
    plan_id: infraPlan.id,
    status: 'succeeded',
    killswitched: false,
    partial_state: false,
    resources_added: 1,
    resources_changed: 0,
    resources_destroyed: 0,
    state_encrypted: encryptSecret(RAW_STATE),
    state_present: true,
    outputs_sanitised: {
      endpoint: 'https://events.example.internal',
      password: 'shouldnt-be-rendered',
    } as unknown as InfraApply['outputs_sanitised'],
    billed_usd_per_month: 60,
    error_message: null,
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };

  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.build_files = files.map(
    (f) => f as unknown as Record<string, unknown>,
  );
  db.tables.infra_plans = [infraPlan as unknown as Record<string, unknown>];
  db.tables.infra_applies = [apply as unknown as Record<string, unknown>];

  return { project, build, apply, infraPlan };
}

function seedCloudConnection(db: InMemoryDb) {
  db.tables.connections = [
    {
      id: 'conn-cloud-1',
      user_id: FAKE_USER.id,
      provider: 'cloud',
      account_login: 'aws-us-east-1',
      token_encrypted: encryptSecret(
        JSON.stringify({
          AWS_ACCESS_KEY_ID: 'AKIAFAKE',
          AWS_SECRET_ACCESS_KEY: 'secret',
          AWS_REGION: 'us-east-1',
        }),
      ),
      scopes: null,
      key_last4: null,
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
}

function seedKillSwitch(db: InMemoryDb) {
  db.tables.kill_switches = [
    {
      id: 'ks-1',
      scope: 'project',
      scope_id: PROJECT_ID,
      active: true,
      reason: 'frozen by operator',
      set_by: FAKE_USER.id,
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
}

function inSyncDiff(): InfraPlanDiff {
  return {
    resources: [],
    create_count: 0,
    change_count: 0,
    replace_count: 0,
    destroy_count: 0,
    destructive: false,
    terraform_version: '1.6.0',
    provider_metadata: [],
  };
}

function driftedDiff(): InfraPlanDiff {
  return {
    resources: [
      {
        address: 'module.data_events_db.aws_db_instance.this',
        type: 'aws_db_instance',
        module: 'data_events_db',
        action: 'change',
      },
    ],
    create_count: 0,
    change_count: 1,
    replace_count: 0,
    destroy_count: 0,
    destructive: true,
    terraform_version: '1.6.0',
    provider_metadata: [],
  };
}

function makeStubProvider(diff: InfraPlanDiff): CloudProvider {
  return {
    name: 'stub',
    kind: 'terraform_cli',
    plan: vi.fn(async () => ({
      diff,
      plan_artifact_b64: 'fake-artifact',
    })),
    apply: vi.fn(),
    destroy: vi.fn(async () => ({
      ok: true,
      aborted: false,
      resources_destroyed: 1,
      state: '{}',
      partial_state: false,
      error: null,
    })),
  } as unknown as CloudProvider;
}

function makePost(body?: unknown): Request {
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
  vi.mocked(selectCloudProvider).mockReset();
  dbHolder.current = null;
});

describe('Phase 4-6 INFRA monitor + drift + freeze hermetic dry-run', () => {
  // ========================================================================
  // DASHBOARD PAYLOAD assembly — sanitised; no encrypted state;
  // secret-named keys masked; accruing cost surfaced.
  // ========================================================================
  it('assembleInfraDashboard: no encrypted state in payload; secret-named keys masked; accruing cost present', () => {
    const db = createInMemoryDb();
    const { project, build, apply } = seedProvisionedInfra(db);

    const payload = assembleInfraDashboard({
      project,
      build,
      spec: CANNED_INFRA_SPEC,
      apply,
      drift: null,
      accruedUsdTotal: 12.34,
      ceilingPeriod: 'monthly',
      ceilingLimitUsd: 1000,
      killSwitch: { active: false, scope: null, reason: null },
      typedPhraseRequired: 'DESTROY standing-pipeline',
    });

    // === SECRET HYGIENE — the raw state must NOT appear anywhere. ===
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(RAW_STATE);
    expect(serialised).not.toContain('super-secret-rds-master');
    expect(serialised).not.toContain(apply.state_encrypted ?? '');
    // The payload TYPE has no state_encrypted field by construction.
    expect('state_encrypted' in (payload as unknown as object)).toBe(false);

    // === Outputs — 'password' is a secret-named key → masked. ===
    expect(payload.outputs_masked.password).toBe(
      '[redacted · secret-named key]',
    );
    // Non-secret output renders verbatim.
    expect(payload.outputs_masked.endpoint).toBe(
      'https://events.example.internal',
    );

    // === Costs — accrued + monthly + ceiling all surfaced. ===
    expect(payload.billed_usd_per_month).toBe(60);
    expect(payload.accrued_usd_total).toBe(12.34);
    expect(payload.ceiling_period).toBe('monthly');
    expect(payload.ceiling_limit_usd).toBe(1000);

    // === Live + not frozen. ===
    expect(payload.live).toBe(true);
    expect(payload.frozen).toBe(false);

    // === Lifecycle hint surfaces ephemeral. ===
    expect(payload.lifecycle).toBe('ephemeral');
    expect(payload.summary.has_ephemeral_lifecycle).toBe(true);

    // === Drift verdict 'unknown' when no row. ===
    expect(payload.drift.verdict).toBe('unknown');
    expect(payload.drift.checked_at).toBeNull();
  });

  it('assembleInfraDashboard with active kill switch → frozen=true, live=false', () => {
    const db = createInMemoryDb();
    const { project, build, apply } = seedProvisionedInfra(db);

    const payload = assembleInfraDashboard({
      project,
      build,
      spec: CANNED_INFRA_SPEC,
      apply,
      drift: null,
      accruedUsdTotal: 5,
      ceilingPeriod: 'monthly',
      ceilingLimitUsd: 1000,
      killSwitch: { active: true, scope: 'project', reason: 'budget freeze' },
      typedPhraseRequired: 'DESTROY standing-pipeline',
    });
    expect(payload.frozen).toBe(true);
    expect(payload.live).toBe(false);
    expect(payload.kill_switch.active).toBe(true);
    expect(payload.kill_switch.scope).toBe('project');
    expect(payload.kill_switch.reason).toBe('budget freeze');
  });

  it('assembleInfraDashboard surfaces drift verdict + counts when a row exists', () => {
    const db = createInMemoryDb();
    const { project, build, apply } = seedProvisionedInfra(db);
    const drift: InfraDriftCheck = {
      id: 'drift-1',
      project_id: project.id,
      build_id: build.id,
      apply_id: apply.id,
      verdict: 'drifted',
      create_count: 0,
      change_count: 1,
      destroy_count: 0,
      diff_summary: null,
      error_message: null,
      created_at: '2026-01-15T12:00:00.000Z',
    };

    const payload = assembleInfraDashboard({
      project,
      build,
      spec: CANNED_INFRA_SPEC,
      apply,
      drift,
      accruedUsdTotal: 0,
      ceilingPeriod: null,
      ceilingLimitUsd: null,
      killSwitch: { active: false, scope: null, reason: null },
      typedPhraseRequired: 'DESTROY standing-pipeline',
    });
    expect(payload.drift.verdict).toBe('drifted');
    expect(payload.drift.change_count).toBe(1);
    expect(payload.drift.checked_at).toBe('2026-01-15T12:00:00.000Z');
  });

  // ========================================================================
  // CHECK-DRIFT route — reuses CloudProvider.plan() read-only.
  // ========================================================================
  it('check-drift returns in_sync when the stub returns a no-change diff', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedProvisionedInfra(db);
    seedCloudConnection(db);
    vi.mocked(selectCloudProvider).mockReturnValue(makeStubProvider(inSyncDiff()));

    const r = await checkDriftPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      status: string;
      create_count: number;
      change_count: number;
      destroy_count: number;
      terraform_apply_invoked: boolean;
      cloud_write_count: number;
    };
    expect(body.status).toBe('in_sync');
    expect(body.create_count).toBe(0);
    expect(body.change_count).toBe(0);
    expect(body.destroy_count).toBe(0);
    // Boundary markers — drift is read-only.
    expect(body.terraform_apply_invoked).toBe(false);
    expect(body.cloud_write_count).toBe(0);

    // Drift row persisted with verdict=in_sync.
    const rows = (db.tables.infra_drift_checks ?? []) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('in_sync');

    // Audit: drift_started + drift_checked (no apply event).
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((rr) => rr.action === 'infra.drift_check_started')).toBe(
      true,
    );
    expect(audit.some((rr) => rr.action === 'infra.drift_checked')).toBe(true);
    expect(audit.some((rr) => rr.action === 'infra.apply_started')).toBe(false);
  });

  it('check-drift returns drifted when the stub diff has changes', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedProvisionedInfra(db);
    seedCloudConnection(db);
    vi.mocked(selectCloudProvider).mockReturnValue(makeStubProvider(driftedDiff()));

    const r = await checkDriftPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; change_count: number };
    expect(body.status).toBe('drifted');
    expect(body.change_count).toBe(1);

    const rows = (db.tables.infra_drift_checks ?? []) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('drifted');
    expect(rows[0]?.change_count).toBe(1);
  });

  it('check-drift refuses with 412 when no cloud connection is configured', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedProvisionedInfra(db);
    // No cloud connection.
    vi.mocked(selectCloudProvider).mockReturnValue(makeStubProvider(inSyncDiff()));

    const r = await checkDriftPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(r.status).toBe(412);
    expect((db.tables.infra_drift_checks ?? []).length).toBe(0);
  });

  it('check-drift refuses a non-provisioned build with 409', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedProvisionedInfra(db);
    (db.tables.builds?.[0] as unknown as Build).status = 'plan_confirmed';
    seedCloudConnection(db);
    vi.mocked(selectCloudProvider).mockReturnValue(makeStubProvider(inSyncDiff()));

    const r = await checkDriftPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(r.status).toBe(409);
    void build;
  });

  // ========================================================================
  // FREEZE — active kill switch blocks /check-drift, /apply, /destroy
  // via assertAllowed. NO auto-destroy.
  // ========================================================================
  it('kill switch active → /check-drift blocked with governance:killed; NO auto-destroy', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedProvisionedInfra(db);
    seedCloudConnection(db);
    seedKillSwitch(db);
    vi.mocked(selectCloudProvider).mockReturnValue(makeStubProvider(inSyncDiff()));

    const r = await checkDriftPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { reason?: string };
    expect(body.reason).toBe('killed');

    // No drift row, no destroy event — freeze never auto-destroys.
    expect((db.tables.infra_drift_checks ?? []).length).toBe(0);
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((rr) => rr.action === 'infra.destroyed')).toBe(false);
  });

  it('kill switch active → /apply blocked with governance:killed; NO auto-destroy', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedProvisionedInfra(db);
    // Re-seed build at plan_confirmed so /apply's status check
    // would otherwise pass.
    (db.tables.builds?.[0] as unknown as Build).status = 'plan_confirmed';
    seedCloudConnection(db);
    seedKillSwitch(db);
    vi.mocked(selectCloudProvider).mockReturnValue(makeStubProvider(inSyncDiff()));

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { reason?: string };
    expect(body.reason).toBe('killed');

    // No apply row, no destroy event.
    expect((db.tables.infra_applies ?? []).length).toBe(1); // pre-existing
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((rr) => rr.action === 'infra.destroyed')).toBe(false);
    expect(audit.some((rr) => rr.action === 'infra.apply_started')).toBe(false);
  });

  it('kill switch active → /destroy blocked with governance:killed even with typed_confirm', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedProvisionedInfra(db);
    seedCloudConnection(db);
    seedKillSwitch(db);
    vi.mocked(selectCloudProvider).mockReturnValue(makeStubProvider(inSyncDiff()));

    const r = await destroyPOST(
      makePost({ typed_confirm: 'DESTROY standing-pipeline' }),
      { params: { id: PROJECT_ID } },
    );
    expect(r.status).toBe(503);
    const body = (await r.json()) as { reason?: string };
    expect(body.reason).toBe('killed');

    // Build NOT flipped to destroying.
    const reloaded = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(reloaded?.status).toBe('provisioned');
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((rr) => rr.action === 'infra.destroyed')).toBe(false);
  });

  it('clearing the kill switch allows /check-drift to run again', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedProvisionedInfra(db);
    seedCloudConnection(db);
    seedKillSwitch(db);
    vi.mocked(selectCloudProvider).mockReturnValue(makeStubProvider(inSyncDiff()));

    // First attempt blocked.
    const blocked = await checkDriftPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(blocked.status).toBe(503);

    // Operator clears the switch.
    (db.tables.kill_switches?.[0] as Record<string, unknown>).active = false;

    // Retry succeeds.
    const r = await checkDriftPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string };
    expect(body.status).toBe('in_sync');
  });

  // ========================================================================
  // TEARDOWN — reuses /infra/build/destroy + typed confirm.
  // ========================================================================
  it('teardown reuses the destroy gate: typed confirm required; routes to /infra/build/destroy', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedProvisionedInfra(db);
    seedCloudConnection(db);
    const destroySpy = vi.fn(async () => ({
      ok: true,
      aborted: false,
      resources_destroyed: 1,
      state: '{}',
      partial_state: false,
      error: null,
    }));
    vi.mocked(selectCloudProvider).mockReturnValue({
      name: 'stub',
      kind: 'terraform_cli',
      plan: vi.fn(),
      apply: vi.fn(),
      destroy: destroySpy,
    } as unknown as CloudProvider);

    // Click without phrase → 403.
    const noPhrase = await destroyPOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(noPhrase.status).toBe(403);
    expect(destroySpy).toHaveBeenCalledTimes(0);

    // Wrong phrase → 403.
    const wrong = await destroyPOST(
      makePost({ typed_confirm: 'DESTROY wrong-slug' }),
      { params: { id: PROJECT_ID } },
    );
    expect(wrong.status).toBe(403);
    expect(destroySpy).toHaveBeenCalledTimes(0);

    // Exact phrase → 200 + 'destroyed'.
    const ok = await destroyPOST(
      makePost({ typed_confirm: 'DESTROY standing-pipeline' }),
      { params: { id: PROJECT_ID } },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { status: string };
    expect(body.status).toBe('destroyed');
    expect(destroySpy).toHaveBeenCalledTimes(1);

    // Build → 'destroyed'.
    const reloaded = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(reloaded?.status).toBe('destroyed');
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((rr) => rr.action === 'infra.rollback_requested')).toBe(
      true,
    );
    expect(audit.some((rr) => rr.action === 'infra.destroyed')).toBe(true);
  });

  // ========================================================================
  // HERMETICITY.
  // ========================================================================
  it('zero real fetch calls across the whole infra monitor dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
