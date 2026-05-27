// Hermetic end-to-end dry-run — Phase 4-5b (Infrastructure) APPLY +
// ROLLBACK / DESTROY.
//
// This is the most important test file in the engine. The apply is
// the ONLY cloud write, the ONLY place real resources are created
// and real money spent. Every boundary has to hold even under a
// hostile fixture.
//
// Companion to infra-plan-dryrun.test.ts. That file stops at
// 'plan_confirmed'. This one picks up there and drives:
//
//   1. PREREQUISITE — only 'plan_confirmed' (or 'apply_failed' for
//      retry) can apply. 'previewed' / 'plan_blocked' refuse 409.
//   2. ARTIFACT PARITY — the stub asserts it receives the EXACT
//      base64 artifact from the confirmed plan row.
//   3. PRE-APPLY KILL SWITCH — an active project-scope kill
//      switch refuses the apply with 503; provider.apply is NEVER
//      called.
//   4. MID-APPLY KILL SWITCH — the watcher polls; the stub
//      yields to a flipped kill switch via AbortSignal; the route
//      persists 'apply_failed' (killswitched) with partial state
//      captured + encrypted.
//   5. APPLY SUCCESS — build → 'provisioned'; state ENCRYPTED at
//      rest (raw NEVER in response/audit; the stored blob
//      decrypts back); ledger billed.
//   6. APPLY FAILURE — partial state captured + encrypted; NO
//      auto-destroy.
//   7. DESTROY — without typed_confirm → 403; wrong phrase →
//      403; exact phrase → 'destroyed'.
//   8. NO CLOUD CONNECTION → 412 for both routes.
//   9. ZERO REAL FETCH (stubbed end-to-end).
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Lower the kill-switch watcher's poll cadence so the mid-apply
// race test resolves well within the 8s safety net. Production code
// uses 2 s; tests use 50 ms.
process.env.INFRA_KILL_SWITCH_POLL_MS = '50';
import type {
  Budget,
  Build,
  BuildFile,
  InfraApply,
  InfraPlan,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
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
  CloudApplyResult,
  CloudDestroyResult,
} from '@/lib/engine/infra/cloud/provider';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Boundary mocks. Set BEFORE importing the route handlers.
// ---------------------------------------------------------------------------

const FAKE_USER = { id: 'user-infra-apply-dry-run', email: 'test@example.com' };
const PROJECT_ID = 'project-infra-apply-dry-run';
const PROJECT_NAME = 'Ingest Pipeline';
const PLAN_ARTIFACT_B64 = 'aurexis-confirmed-plan-artifact-base64';
const RAW_STATE = JSON.stringify({
  resources: [{ type: 'aws_db_instance', name: 'this' }],
  // A realistic terraform state often carries a secret in attributes;
  // we include one so the encryption assertions are meaningful.
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
        status: 'plan_confirmed',
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

// CloudProvider stubbed end-to-end. Tests script `apply` + `destroy`
// outcomes; the real TerraformCliProvider is NEVER instantiated, no
// `terraform` is spawned, no cloud call fires.
vi.mock('@/lib/engine/infra/cloud/select', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/engine/infra/cloud/select')
  >();
  return { ...actual, selectCloudProvider: vi.fn() };
});

// Ledger — stub recordCost so the test asserts it's CALLED (apply
// success bills it) but doesn't need a working pricing model.
vi.mock('@/lib/engine/governance/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/ledger')>();
  return {
    ...actual,
    recordCost: vi.fn(async () => ({ amount_usd: 0, event_id: 'evt-stub' })),
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

import { POST as applyPOST } from '@/app/api/projects/[id]/infra/build/apply/route';
import { POST as destroyPOST } from '@/app/api/projects/[id]/infra/build/destroy/route';
import { selectCloudProvider } from '@/lib/engine/infra/cloud/select';
import { recordCost } from '@/lib/engine/governance/ledger';

// ---------------------------------------------------------------------------
// Canned data.
// ---------------------------------------------------------------------------

const CANNED_INFRA_SPEC: InfraSpec = InfraSpecSchema.parse({
  goal: 'Ingest pipeline.',
  region: 'us-east-1',
  lifecycle: 'persistent',
  resources: [
    {
      id: 'events_db',
      type: 'postgres_db',
      config: { version: '15', storage_gb: 40 },
    },
    {
      id: 'ingest_worker',
      type: 'worker',
      config: { image: 'aurexis/ingest:1.0.0' },
      sizing: { instances: 2 },
    },
  ],
  topology: [{ from: 'ingest_worker', to: 'events_db' }],
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

function seedConfirmedInfra(
  db: InMemoryDb,
  opts: {
    buildStatus?: Build['status'];
    planConfirmed?: boolean;
    // Explicit `null` is honoured (used by the "no artifact" test).
    // `undefined` falls back to the default.
    artifact?: string | null;
    typedPhrase?: string;
  } = {},
): { project: Project; build: Build; infraPlan: InfraPlan } {
  const buildStatus = opts.buildStatus ?? 'plan_confirmed';
  const planConfirmed = opts.planConfirmed ?? true;
  const artifact =
    'artifact' in opts ? opts.artifact ?? null : PLAN_ARTIFACT_B64;
  const typedPhrase = opts.typedPhrase ?? 'DESTROY ingest-pipeline';

  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: PROJECT_NAME,
    status: 'plan_confirmed',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-infra-apply-1',
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
    id: 'plan-infra-apply-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_INFRA_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-infra-apply-1',
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
  ];
  const infraPlan: InfraPlan = {
    id: 'infraplan-1',
    project_id: project.id,
    build_id: build.id,
    plan_diff: {
      resources: [],
      create_count: 5,
      change_count: 0,
      replace_count: 0,
      destroy_count: 0,
      destructive: false,
      terraform_version: '1.6.0',
      provider_metadata: [],
    } as unknown as InfraPlan['plan_diff'],
    destructive: false,
    create_count: 5,
    change_count: 0,
    destroy_count: 0,
    ceiling_verdict: 'within_budget',
    ceiling_period: 'monthly',
    ceiling_limit_usd: 1000,
    ceiling_projected_usd: 100,
    ceiling_message: 'within budget',
    confirmed_by_user_id: planConfirmed ? FAKE_USER.id : null,
    typed_phrase_required: typedPhrase,
    typed_phrase_verified: planConfirmed,
    confirmed_at: planConfirmed ? new Date().toISOString() : null,
    plan_artifact_b64: artifact,
    created_at: new Date().toISOString(),
  };

  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.build_files = files.map(
    (f) => f as unknown as Record<string, unknown>,
  );
  db.tables.infra_plans = [infraPlan as unknown as Record<string, unknown>];
  return { project, build, infraPlan };
}

function seedCloudConnection(db: InMemoryDb) {
  const envBag = {
    AWS_ACCESS_KEY_ID: 'AKIAFAKE000000000000',
    AWS_SECRET_ACCESS_KEY: 'secret-not-a-real-key',
    AWS_REGION: 'us-east-1',
  };
  const tokenEncrypted = encryptSecret(JSON.stringify(envBag));
  db.tables.connections = [
    {
      id: 'conn-cloud-1',
      user_id: FAKE_USER.id,
      provider: 'cloud',
      account_login: 'aws-us-east-1',
      token_encrypted: tokenEncrypted,
      scopes: null,
      key_last4: null,
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
}

function seedKillSwitch(db: InMemoryDb, scope: 'project' | 'user' | 'global' = 'project') {
  db.tables.kill_switches = [
    {
      id: 'ks-1',
      scope,
      scope_id: scope === 'global' ? null : scope === 'user' ? FAKE_USER.id : PROJECT_ID,
      active: true,
      reason: 'test',
      set_by: FAKE_USER.id,
      created_at: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  ];
}

function flipKillSwitchActive(db: InMemoryDb) {
  // The in-memory supabase lazily creates `kill_switches = []` on
  // the watcher's first SELECT, so the table may exist but be
  // empty by the time the stub runs. Treat empty-or-missing the
  // same — seed a fresh active row either way.
  const existing = db.tables.kill_switches;
  if (!existing || existing.length === 0) {
    seedKillSwitch(db);
  } else {
    (existing[0] as Record<string, unknown>).active = true;
  }
}

interface ApplyStubOpts {
  result?: Partial<CloudApplyResult>;
  // When set, the stubbed apply will WAIT until its signal is
  // aborted (used to exercise the mid-flight kill-switch watcher).
  // While it's waiting, the test flips the kill switch on the in-
  // memory DB; the watcher's poll picks it up and aborts.
  raceKillSwitch?: { db: InMemoryDb };
}

function makeStubProvider(opts: ApplyStubOpts = {}): {
  provider: CloudProvider;
  applySpy: ReturnType<typeof vi.fn>;
  destroySpy: ReturnType<typeof vi.fn>;
} {
  const applySpy = vi.fn(
    async (input: Parameters<CloudProvider['apply']>[0]) => {
      if (opts.raceKillSwitch) {
        flipKillSwitchActive(opts.raceKillSwitch.db);
        await new Promise<void>((resolve, reject) => {
          if (input.signal?.aborted) {
            resolve();
            return;
          }
          input.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
          // Safety — bound the race window so a regression in the
          // watcher doesn't hang the test indefinitely.
          setTimeout(
            () => reject(new Error('watcher did not abort within 8s')),
            8_000,
          );
        });
        return {
          ok: false,
          aborted: true,
          resources_added: 1,
          resources_changed: 0,
          resources_destroyed: 0,
          state: RAW_STATE,
          partial_state: true,
          outputs: {},
          error: null,
        } satisfies CloudApplyResult;
      }
      return {
        ok: true,
        aborted: false,
        resources_added: 5,
        resources_changed: 0,
        resources_destroyed: 0,
        state: RAW_STATE,
        partial_state: false,
        outputs: { endpoint: 'https://events.example.internal' },
        error: null,
        ...opts.result,
      } satisfies CloudApplyResult;
    },
  );
  const destroySpy = vi.fn(
    async (): Promise<CloudDestroyResult> => ({
      ok: true,
      aborted: false,
      resources_destroyed: 5,
      state: '{}',
      partial_state: false,
      error: null,
    }),
  );
  return {
    provider: {
      name: 'stub',
      kind: 'terraform_cli',
      plan: vi.fn(),
      apply: applySpy,
      destroy: destroySpy,
    } as unknown as CloudProvider,
    applySpy,
    destroySpy,
  };
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
  vi.mocked(recordCost).mockReset();
  vi.mocked(recordCost).mockResolvedValue({
    amount_usd: 0,
    event_id: 'evt-stub',
  });
  dbHolder.current = null;
});

describe('Phase 4-5b INFRA apply + rollback hermetic dry-run', () => {
  // ========================================================================
  // PREREQUISITE — only 'plan_confirmed' can apply.
  // ========================================================================
  it('refuses build status "previewed" with 409; provider.apply NEVER called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db, { buildStatus: 'previewed' });
    seedCloudConnection(db);
    const { provider, applySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(409);
    expect(applySpy).toHaveBeenCalledTimes(0);
    expect((db.tables.infra_applies ?? []).length).toBe(0);
  });

  it('refuses an unconfirmed plan row with 409', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db, { planConfirmed: false });
    seedCloudConnection(db);
    const { provider, applySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(409);
    expect(applySpy).toHaveBeenCalledTimes(0);
  });

  it('refuses a plan row with no saved artifact (artifact null) with 409', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db, { artifact: null });
    seedCloudConnection(db);
    const { provider, applySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(409);
    expect(applySpy).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // CONNECTION — 412 when no cloud connection.
  // ========================================================================
  it('refuses with 412 when no cloud connection is configured; provider.apply NEVER called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db);
    const { provider, applySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(412);
    expect(applySpy).toHaveBeenCalledTimes(0);
    expect((db.tables.infra_applies ?? []).length).toBe(0);
  });

  // ========================================================================
  // PRE-APPLY KILL SWITCH — refused with 503; provider.apply never called.
  // ========================================================================
  it('PRE-apply kill switch active → 503 killed; provider.apply NEVER called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db);
    seedCloudConnection(db);
    seedKillSwitch(db);
    const { provider, applySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { reason?: string };
    expect(body.reason).toBe('killed');
    expect(applySpy).toHaveBeenCalledTimes(0);
    expect((db.tables.infra_applies ?? []).length).toBe(0);
  });

  // ========================================================================
  // APPLY SUCCESS — happy path. Artifact parity asserted; state
  // encrypted; ledger billed; raw state NEVER in response/audit.
  // ========================================================================
  it('apply success: artifact parity → "provisioned"; state ENCRYPTED at rest; ledger billed; secret NEVER in response/audit', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedConfirmedInfra(db);
    seedCloudConnection(db);
    const { provider, applySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = JSON.parse(text) as {
      status: string;
      apply: {
        state_present: boolean;
        outputs_sanitised: Record<string, unknown>;
      };
      cloud_write_count: number;
    };
    expect(body.status).toBe('provisioned');
    expect(body.cloud_write_count).toBe(1);
    // The sanitised payload has state_present=true but no raw blob.
    expect(body.apply.state_present).toBe(true);

    // === ARTIFACT PARITY — the stub received EXACTLY the confirmed
    // artifact from the plan row. ===
    expect(applySpy).toHaveBeenCalledTimes(1);
    const applyArgs = applySpy.mock.calls[0]?.[0] as {
      planArtifactB64: string;
      credentials: { env: Record<string, string> };
    };
    expect(applyArgs.planArtifactB64).toBe(PLAN_ARTIFACT_B64);
    // Credentials reach the stub (decrypted from the connection).
    expect(applyArgs.credentials.env.AWS_ACCESS_KEY_ID).toBe(
      'AKIAFAKE000000000000',
    );

    // === RAW STATE not in response. ===
    expect(text).not.toContain('super-secret-rds-master');
    expect(text).not.toContain(RAW_STATE);

    // === Build → 'provisioned'; row carries the ENCRYPTED state. ===
    const reloaded = (db.tables.builds ?? []).find(
      (rr) => rr.id === build.id,
    ) as Build | undefined;
    expect(reloaded?.status).toBe('provisioned');
    const applyRow = (db.tables.infra_applies ?? [])[0] as
      | InfraApply
      | undefined;
    expect(applyRow?.status).toBe('succeeded');
    expect(applyRow?.state_present).toBe(true);
    expect(applyRow?.state_encrypted).toBeTruthy();
    expect(applyRow?.state_encrypted).not.toBe(RAW_STATE);
    expect(applyRow?.state_encrypted).not.toContain(
      'super-secret-rds-master',
    );
    // The stored blob decrypts back to the raw state — proving we
    // encrypted-and-stored, not stored-in-the-clear.
    expect(decryptSecret(applyRow!.state_encrypted!)).toBe(RAW_STATE);

    // === AUDIT — apply_started + apply_completed; NO raw state/
    // creds in any detail blob. ===
    const audit = (db.tables.audit_log ?? []) as Array<
      Record<string, unknown>
    >;
    expect(audit.some((rr) => rr.action === 'infra.apply_started')).toBe(true);
    const completed = audit.find(
      (rr) => rr.action === 'infra.apply_completed',
    ) as { detail?: Record<string, unknown> } | undefined;
    expect(completed).toBeDefined();
    expect(completed?.detail?.cloud_write_count).toBe(1);
    for (const row of audit) {
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain('super-secret-rds-master');
      expect(serialised).not.toContain('AKIAFAKE000000000000');
      expect(serialised).not.toContain(RAW_STATE);
    }

    // === LEDGER billed exactly once. ===
    expect(vi.mocked(recordCost)).toHaveBeenCalledTimes(1);
    const ledgerArgs = vi.mocked(recordCost).mock.calls[0]?.[0];
    expect(ledgerArgs?.kind).toBe('runtime');
    expect(ledgerArgs?.project_id).toBe(PROJECT_ID);
    expect(ledgerArgs?.ref).toMatch(/^infra\.apply\./);
  });

  // ========================================================================
  // MID-APPLY KILL SWITCH — watcher interrupts; partial state
  // captured; audit infra.apply_killswitched.
  // ========================================================================
  it('MID-apply kill-switch flip → watcher aborts; "apply_failed" + partial state captured; audit infra.apply_killswitched', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedConfirmedInfra(db);
    seedCloudConnection(db);
    // Don't seed a kill switch up front — the stub will flip it
    // ONCE apply is in flight, simulating an operator interruption.
    const { provider, applySpy } = makeStubProvider({
      raceKillSwitch: { db },
    });
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(503);
    const body = (await r.json()) as {
      status: string;
      killswitched: boolean;
      apply: { state_present: boolean; partial_state: boolean };
    };
    expect(body.status).toBe('apply_failed');
    expect(body.killswitched).toBe(true);
    expect(body.apply.state_present).toBe(true);
    expect(body.apply.partial_state).toBe(true);

    // Provider WAS called — the apply started. The watcher
    // aborted mid-flight.
    expect(applySpy).toHaveBeenCalledTimes(1);

    // === Build → 'apply_failed'; row carries encrypted partial
    // state + killswitched=true. ===
    const reloaded = (db.tables.builds ?? []).find(
      (rr) => rr.id === build.id,
    ) as Build | undefined;
    expect(reloaded?.status).toBe('apply_failed');
    const applyRow = (db.tables.infra_applies ?? [])[0] as
      | InfraApply
      | undefined;
    expect(applyRow?.status).toBe('killswitched');
    expect(applyRow?.killswitched).toBe(true);
    expect(applyRow?.partial_state).toBe(true);
    expect(applyRow?.state_present).toBe(true);
    expect(decryptSecret(applyRow!.state_encrypted!)).toBe(RAW_STATE);

    // === Audit: killswitched event present, NOT generic failed. ===
    const audit = (db.tables.audit_log ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      audit.some((rr) => rr.action === 'infra.apply_killswitched'),
    ).toBe(true);
    expect(audit.some((rr) => rr.action === 'infra.apply_completed')).toBe(
      false,
    );

    // === NO auto-destroy — the partial-state apply row stays in
    // place; the build stays at 'apply_failed' until the user
    // explicitly rolls back via /destroy. ===
    // (No destroy event in the audit, no destroy attempt persisted.)
    expect(audit.some((rr) => rr.action === 'infra.destroyed')).toBe(false);

    // === LEDGER NOT billed on a killswitched apply. ===
    expect(vi.mocked(recordCost)).toHaveBeenCalledTimes(0);
  }, 15_000);

  // ========================================================================
  // APPLY FAILURE — generic error; partial state captured; no
  // auto-destroy.
  // ========================================================================
  it('apply failure (provider returns ok=false) → "apply_failed" + partial state captured; NO auto-destroy', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedConfirmedInfra(db);
    seedCloudConnection(db);
    const { provider } = makeStubProvider({
      result: {
        ok: false,
        aborted: false,
        resources_added: 2,
        resources_changed: 0,
        resources_destroyed: 0,
        state: RAW_STATE,
        partial_state: true,
        outputs: {},
        error: 'provider rejected: subnet group capacity',
      },
    });
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await applyPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(r.status).toBe(502);
    const body = (await r.json()) as {
      status: string;
      killswitched: boolean;
      apply: { state_present: boolean; partial_state: boolean };
    };
    expect(body.status).toBe('apply_failed');
    expect(body.killswitched).toBe(false);
    expect(body.apply.state_present).toBe(true);

    const reloaded = (db.tables.builds ?? []).find(
      (rr) => rr.id === build.id,
    ) as Build | undefined;
    expect(reloaded?.status).toBe('apply_failed');
    const applyRow = (db.tables.infra_applies ?? [])[0] as
      | InfraApply
      | undefined;
    expect(applyRow?.status).toBe('failed');
    expect(applyRow?.killswitched).toBe(false);
    expect(applyRow?.partial_state).toBe(true);
    expect(applyRow?.error_message).toMatch(/subnet group capacity/);

    const audit = (db.tables.audit_log ?? []) as Array<
      Record<string, unknown>
    >;
    expect(audit.some((rr) => rr.action === 'infra.apply_failed')).toBe(true);
    expect(audit.some((rr) => rr.action === 'infra.destroyed')).toBe(false);
    expect(vi.mocked(recordCost)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // DESTROY — typed-confirm gate.
  // ========================================================================
  it('destroy without typed_confirm → 403; provider.destroy NEVER called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db, { buildStatus: 'provisioned' });
    seedCloudConnection(db);
    // Need an apply row with captured state to destroy against.
    db.tables.infra_applies = [
      {
        id: 'apply-1',
        project_id: PROJECT_ID,
        build_id: 'build-infra-apply-1',
        plan_id: 'infraplan-1',
        status: 'succeeded',
        killswitched: false,
        partial_state: false,
        resources_added: 5,
        resources_changed: 0,
        resources_destroyed: 0,
        state_encrypted: encryptSecret(RAW_STATE),
        state_present: true,
        outputs_sanitised: {},
        billed_usd_per_month: 100,
        error_message: null,
        created_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];
    const { provider, destroySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const noBody = await destroyPOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(noBody.status).toBe(403);
    expect(destroySpy).toHaveBeenCalledTimes(0);

    const wrong = await destroyPOST(
      makePost({ typed_confirm: 'DESTROY wrong-slug' }),
      { params: { id: PROJECT_ID } },
    );
    expect(wrong.status).toBe(403);
    expect(destroySpy).toHaveBeenCalledTimes(0);
  });

  it('destroy with EXACT typed_confirm → "destroyed"; provider.destroy invoked with decrypted state', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedConfirmedInfra(db, { buildStatus: 'provisioned' });
    seedCloudConnection(db);
    db.tables.infra_applies = [
      {
        id: 'apply-1',
        project_id: PROJECT_ID,
        build_id: build.id,
        plan_id: 'infraplan-1',
        status: 'succeeded',
        killswitched: false,
        partial_state: false,
        resources_added: 5,
        resources_changed: 0,
        resources_destroyed: 0,
        state_encrypted: encryptSecret(RAW_STATE),
        state_present: true,
        outputs_sanitised: {},
        billed_usd_per_month: 100,
        error_message: null,
        created_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];
    const { provider, destroySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await destroyPOST(
      makePost({ typed_confirm: 'DESTROY ingest-pipeline' }),
      { params: { id: PROJECT_ID } },
    );
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = JSON.parse(text) as { status: string };
    expect(body.status).toBe('destroyed');

    // provider.destroy received the DECRYPTED state.
    expect(destroySpy).toHaveBeenCalledTimes(1);
    const destroyArgs = destroySpy.mock.calls[0]?.[0] as {
      state: string;
      credentials: { env: Record<string, string> };
    };
    expect(destroyArgs.state).toBe(RAW_STATE);
    expect(destroyArgs.credentials.env.AWS_ACCESS_KEY_ID).toBe(
      'AKIAFAKE000000000000',
    );

    // Response does NOT carry the raw state.
    expect(text).not.toContain('super-secret-rds-master');

    // Build → 'destroyed'; apply row updated.
    const reloaded = (db.tables.builds ?? []).find(
      (rr) => rr.id === build.id,
    ) as Build | undefined;
    expect(reloaded?.status).toBe('destroyed');
    const applyRow = (db.tables.infra_applies ?? [])[0] as
      | InfraApply
      | undefined;
    expect(applyRow?.status).toBe('destroyed');
    expect(applyRow?.resources_destroyed).toBe(5);

    // Audit: rollback_requested + destroyed.
    const audit = (db.tables.audit_log ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      audit.some((rr) => rr.action === 'infra.rollback_requested'),
    ).toBe(true);
    expect(audit.some((rr) => rr.action === 'infra.destroyed')).toBe(true);
    // No raw state or creds anywhere in the audit blobs.
    for (const row of audit) {
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain('super-secret-rds-master');
      expect(serialised).not.toContain('AKIAFAKE000000000000');
      expect(serialised).not.toContain(RAW_STATE);
    }
  });

  it('destroy refuses build status "previewed" with 409', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db, { buildStatus: 'previewed' });
    seedCloudConnection(db);
    const { provider, destroySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await destroyPOST(
      makePost({ typed_confirm: 'DESTROY ingest-pipeline' }),
      { params: { id: PROJECT_ID } },
    );
    expect(r.status).toBe(409);
    expect(destroySpy).toHaveBeenCalledTimes(0);
  });

  it('destroy refuses when no apply row exists with 409', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db, { buildStatus: 'provisioned' });
    seedCloudConnection(db);
    const { provider, destroySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await destroyPOST(
      makePost({ typed_confirm: 'DESTROY ingest-pipeline' }),
      { params: { id: PROJECT_ID } },
    );
    expect(r.status).toBe(409);
    expect(destroySpy).toHaveBeenCalledTimes(0);
  });

  it('destroy refuses with 412 when no cloud connection is configured', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedConfirmedInfra(db, { buildStatus: 'provisioned' });
    // No cloud connection.
    db.tables.infra_applies = [
      {
        id: 'apply-1',
        project_id: PROJECT_ID,
        build_id: 'build-infra-apply-1',
        plan_id: 'infraplan-1',
        status: 'succeeded',
        killswitched: false,
        partial_state: false,
        resources_added: 5,
        resources_changed: 0,
        resources_destroyed: 0,
        state_encrypted: encryptSecret(RAW_STATE),
        state_present: true,
        outputs_sanitised: {},
        billed_usd_per_month: 100,
        error_message: null,
        created_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];
    const { provider, destroySpy } = makeStubProvider();
    vi.mocked(selectCloudProvider).mockReturnValue(provider);

    const r = await destroyPOST(
      makePost({ typed_confirm: 'DESTROY ingest-pipeline' }),
      { params: { id: PROJECT_ID } },
    );
    expect(r.status).toBe(412);
    expect(destroySpy).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // HERMETICITY.
  // ========================================================================
  it('zero real fetch calls across the whole infra apply dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
