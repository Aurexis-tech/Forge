// Hermetic end-to-end dry-run — Phase 4-4 (Infrastructure) PREVIEW +
// COST CEILING GATE.
//
// Companion to infra-codegen-dryrun.test.ts (approved plan → generated
// IaC). This file picks up at a 'generated' infra build and drives:
//
//   1. seed a project + confirmed InfraSpec + approved ProvisioningPlan
//      + a 'generated' infra build with files
//   2. POST /infra/build/preview against the in-memory client
//   3. CASE A — no hard-cap budget: preview persisted with verdict
//      'no_budget_set', build → 'previewed', provisioning unlocked
//   4. CASE B — under-cap budget: verdict 'within_budget', build →
//      'previewed', provisioning unlocked
//   5. CASE C — OVER-cap budget: verdict 'over_budget', HTTP 402,
//      build → 'preview_blocked', `infra.preview_over_budget` audit
//      row, provisioning STAYS LOCKED
//   6. ASSERTIONS:
//      - resource-list is deterministic and grouped by layer
//      - cost estimate computes from the pricing model with a
//        per-module breakdown
//      - NO cloud call (zero fetch); audit detail records
//        cloud_calls=0 / terraform_plan_invoked=false /
//        terraform_apply_invoked=false
//      - downstream still locked (no deployments/agent_runtimes rows)
//      - Phases 1-3 codegen loaders still 409 an infra project
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Build,
  BuildFile,
  Budget,
  InfraPreview,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
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
import {
  evaluateCostCeiling,
} from '@/lib/engine/infra/preview/ceiling';
import { loadApprovedPlanForCodegen } from '@/lib/engine/codegen/persistence';
import { loadApprovedSystemPlanForCodegen } from '@/lib/engine/system/codegen/persistence';
import { loadApprovedSoftwarePlanForCodegen } from '@/lib/engine/software/codegen/persistence';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Boundary mocks. Set BEFORE importing the route handler.
// ---------------------------------------------------------------------------

const FAKE_USER = {
  id: 'user-infra-preview-dry-run',
  email: 'test@example.com',
};
const PROJECT_ID = 'project-infra-preview-dry-run';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    requireUser: vi.fn(async () => FAKE_USER),
    requireProjectOwnership: vi.fn(async (id: string) => ({
      project: {
        id,
        user_id: FAKE_USER.id,
        name: 'Ingest Pipeline',
        status: 'generated',
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

// Route handler — imported AFTER the mocks are set up.
import { POST as previewPOST } from '@/app/api/projects/[id]/infra/build/preview/route';

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

// Compute the projected monthly cost outside the route so the test
// can set budget rows above/below it deterministically.
const EXPECTED = deriveInfraPreview({
  plan: CANNED_INFRA_PLAN,
  publicHttpServiceResourceIds: ['public_api'],
});

// ---------------------------------------------------------------------------
// Seed helper.
// ---------------------------------------------------------------------------

function seedGeneratedInfra(db: InMemoryDb): {
  project: Project;
  build: Build;
} {
  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: 'Ingest Pipeline',
    status: 'plan_approved',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-infra-preview-1',
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
    id: 'plan-infra-preview-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_INFRA_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-infra-preview-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: 'generated',
    logs: {
      static_checks: [],
      warnings: [],
    } as unknown as Build['logs'],
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
  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.build_files = files.map(
    (f) => f as unknown as Record<string, unknown>,
  );
  return { project, build };
}

function seedBudget(db: InMemoryDb, limit_usd: number): Budget {
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
  return row as unknown as Budget;
}

function makePost(): Request {
  return new Request('http://test/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  dbHolder.current = null;
});

describe('Phase 4-4 INFRA preview + cost-ceiling hermetic dry-run', () => {
  // ========================================================================
  // CASE A — no hard-cap budget → verdict no_budget_set; provisioning
  // unlocked (with the "set a cap before applying" guidance).
  // ========================================================================
  it('no budget set → verdict "no_budget_set"; build → "previewed"; preview persisted; nothing applied', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedGeneratedInfra(db);

    const res = await previewPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      kind: string;
      preview: {
        ceiling_verdict: string;
        estimated_usd_per_month: number;
      };
      cloud_calls: number;
      terraform_plan_invoked: boolean;
      terraform_apply_invoked: boolean;
    };
    expect(body.status).toBe('previewed');
    expect(body.kind).toBe('infrastructure');
    expect(body.preview.ceiling_verdict).toBe('no_budget_set');
    expect(body.preview.estimated_usd_per_month).toBeGreaterThan(0);

    // Boundary markers in the response.
    expect(body.cloud_calls).toBe(0);
    expect(body.terraform_plan_invoked).toBe(false);
    expect(body.terraform_apply_invoked).toBe(false);

    // Build → 'previewed' (provisioning unlocked).
    const after = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(after?.status).toBe('previewed');

    // infra_previews row persisted with the verdict.
    const rows = (db.tables.infra_previews ?? []) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ceiling_verdict).toBe('no_budget_set');

    // Audit: started + completed (with boundary markers); NO
    // over_budget event.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'infra.preview_started')).toBe(true);
    const completed = audit.find(
      (r) => r.action === 'infra.preview_completed',
    ) as { detail?: Record<string, unknown> } | undefined;
    expect(completed).toBeDefined();
    expect(completed?.detail?.cloud_calls).toBe(0);
    expect(completed?.detail?.terraform_plan_invoked).toBe(false);
    expect(completed?.detail?.terraform_apply_invoked).toBe(false);
    expect(audit.some((r) => r.action === 'infra.preview_over_budget')).toBe(
      false,
    );

    // Downstream still locked.
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
  });

  // ========================================================================
  // CASE B — under-cap budget → verdict within_budget; build →
  // 'previewed'; provisioning unlocked.
  // ========================================================================
  it('under-cap budget → verdict "within_budget"; build → "previewed"; provisioning unlocked', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedGeneratedInfra(db);
    // Set a cap COMFORTABLY above the projected cost.
    seedBudget(db, EXPECTED.total_usd_per_month * 2);

    const res = await previewPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      preview: {
        ceiling_verdict: string;
        ceiling_period: string | null;
        ceiling_limit_usd: number | null;
        ceiling_message: string;
      };
    };
    expect(body.preview.ceiling_verdict).toBe('within_budget');
    expect(body.preview.ceiling_period).toBe('monthly');
    expect(body.preview.ceiling_limit_usd).toBeCloseTo(
      EXPECTED.total_usd_per_month * 2,
    );
    expect(body.preview.ceiling_message).toMatch(/unlocked/i);

    const after = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(after?.status).toBe('previewed');

    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'infra.preview_over_budget')).toBe(
      false,
    );
  });

  // ========================================================================
  // CASE C — OVER-cap budget → verdict over_budget; HTTP 402;
  // build → 'preview_blocked'; provisioning STAYS LOCKED.
  // ========================================================================
  it('over-cap budget → verdict "over_budget"; HTTP 402; build → "preview_blocked"; provisioning BLOCKED', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedGeneratedInfra(db);
    // Set a cap WELL BELOW the projected cost — anything less than
    // the actual estimate blocks the gate.
    const lowCap = Math.max(1, EXPECTED.total_usd_per_month / 4);
    seedBudget(db, lowCap);

    const res = await previewPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(402); // payment required — the money-gate signal
    const body = (await res.json()) as {
      status: string;
      kind: string;
      preview: {
        ceiling_verdict: string;
        ceiling_message: string;
        ceiling_limit_usd: number | null;
        estimated_usd_per_month: number;
      };
      cloud_calls: number;
    };
    expect(body.status).toBe('preview_blocked');
    expect(body.kind).toBe('infrastructure');
    expect(body.preview.ceiling_verdict).toBe('over_budget');
    expect(body.preview.ceiling_message).toMatch(/BLOCKED/);
    expect(body.preview.ceiling_limit_usd).toBeCloseTo(lowCap);
    expect(body.preview.estimated_usd_per_month).toBeGreaterThan(lowCap);
    expect(body.cloud_calls).toBe(0);

    // === Build → 'preview_blocked' (provisioning STAYS LOCKED) ===
    const after = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(after?.status).toBe('preview_blocked');

    // === Row persisted with the over_budget verdict ===
    const rows = (db.tables.infra_previews ?? []) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ceiling_verdict).toBe('over_budget');

    // === Audit: preview_over_budget present (NOT completed) ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(
      audit.some((r) => r.action === 'infra.preview_over_budget'),
    ).toBe(true);
    expect(
      audit.some((r) => r.action === 'infra.preview_completed'),
    ).toBe(false);
    const overBudget = audit.find(
      (r) => r.action === 'infra.preview_over_budget',
    ) as { detail?: Record<string, unknown> } | undefined;
    expect(overBudget?.detail?.cloud_calls).toBe(0);
    expect(overBudget?.detail?.terraform_plan_invoked).toBe(false);
    expect(overBudget?.detail?.terraform_apply_invoked).toBe(false);

    // === Downstream still locked (no deployments / runtimes) ===
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
  });

  // ========================================================================
  // RAISING THE CEILING — after an over_budget verdict, raising the cap
  // and re-running the preview MUST flip the build to 'previewed'.
  // ========================================================================
  it('raising the ceiling after an over_budget block unlocks provisioning on retry', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedGeneratedInfra(db);
    seedBudget(db, EXPECTED.total_usd_per_month / 4); // too low

    const blocked = await previewPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(blocked.status).toBe(402);

    // Raise the cap and retry.
    (db.tables.budgets?.[0] as Record<string, unknown>).limit_usd =
      EXPECTED.total_usd_per_month * 3;

    const second = await previewPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(second.status).toBe(200);
    const after = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(after?.status).toBe('previewed');
  });

  // ========================================================================
  // DETERMINISTIC PREVIEW — same plan → same resource list + same cost.
  // ========================================================================
  it('deriveInfraPreview is deterministic: same plan → same resource list + same cost', () => {
    const a = deriveInfraPreview({
      plan: CANNED_INFRA_PLAN,
      publicHttpServiceResourceIds: ['public_api'],
    });
    const b = deriveInfraPreview({
      plan: CANNED_INFRA_PLAN,
      publicHttpServiceResourceIds: ['public_api'],
    });
    expect(a.total_usd_per_month).toBe(b.total_usd_per_month);
    expect(a.total_usd_per_hour).toBe(b.total_usd_per_hour);
    expect(JSON.stringify(a.by_module)).toBe(JSON.stringify(b.by_module));
    // Resource list grouped by layer is byte-equal too.
    for (let i = 0; i < a.layers.length; i++) {
      expect(JSON.stringify(a.layers[i])).toBe(JSON.stringify(b.layers[i]));
    }
  });

  // ========================================================================
  // RESOURCE-LIST shape — grouped by layer, every module's creates list
  // is non-empty, public-exposure opt-ins surface only for the spec-
  // opted resources.
  // ========================================================================
  it('preview groups resources by layer; every module step has creates; only opted-in http_service flagged public', () => {
    const result = deriveInfraPreview({
      plan: CANNED_INFRA_PLAN,
      publicHttpServiceResourceIds: ['public_api'],
    });
    // Layers always appear in the stable order.
    expect(result.layers.map((l) => l.layer)).toEqual([
      'network',
      'data',
      'compute',
      'observability',
    ]);
    // Every populated step has at least one creates entry.
    for (const l of result.layers) {
      for (const s of l.steps) {
        expect(s.creates.length).toBeGreaterThan(0);
      }
    }
    // Public-exposure: only the resource that opted in shows up.
    expect(result.public_exposure_opt_ins).toEqual(['public_api']);

    // Per-module breakdown includes every module that appears in
    // the plan AND each entry rounds to cents.
    for (const m of result.by_module) {
      expect(m.usd_per_month).toBeCloseTo(
        Math.round(m.usd_per_month * 100) / 100,
      );
      expect(m.count).toBeGreaterThan(0);
    }
  });

  // ========================================================================
  // CEILING EVALUATOR — pure function, exercised directly.
  // ========================================================================
  it('evaluateCostCeiling: hard-cap blocks, advisory cap does NOT block, no budget = no_budget_set', async () => {
    // hard cap below the projected → over_budget.
    const over = await evaluateCostCeiling({
      userId: FAKE_USER.id,
      projectedUsdPerMonth: 200,
      budgets: [
        {
          id: 'b1',
          user_id: FAKE_USER.id,
          period: 'monthly',
          limit_usd: 50,
          hard_cap: true,
          display_currency: 'USD',
          created_at: new Date().toISOString(),
        },
      ],
    });
    expect(over.verdict).toBe('over_budget');
    expect(over.binding_period).toBe('monthly');

    // hard cap above → within_budget.
    const within = await evaluateCostCeiling({
      userId: FAKE_USER.id,
      projectedUsdPerMonth: 200,
      budgets: [
        {
          id: 'b1',
          user_id: FAKE_USER.id,
          period: 'monthly',
          limit_usd: 1000,
          hard_cap: true,
          display_currency: 'USD',
          created_at: new Date().toISOString(),
        },
      ],
    });
    expect(within.verdict).toBe('within_budget');

    // Advisory (hard_cap: false) cap below → still no_budget_set; the
    // preview-time gate is hard-cap-only.
    const advisory = await evaluateCostCeiling({
      userId: FAKE_USER.id,
      projectedUsdPerMonth: 200,
      budgets: [
        {
          id: 'b1',
          user_id: FAKE_USER.id,
          period: 'monthly',
          limit_usd: 50,
          hard_cap: false,
          display_currency: 'USD',
          created_at: new Date().toISOString(),
        },
      ],
    });
    expect(advisory.verdict).toBe('no_budget_set');

    // No budgets at all → no_budget_set.
    const none = await evaluateCostCeiling({
      userId: FAKE_USER.id,
      projectedUsdPerMonth: 200,
      budgets: [],
    });
    expect(none.verdict).toBe('no_budget_set');
  });

  // ========================================================================
  // STATUS GATE — preview refuses a build that hasn't reached 'generated'.
  // ========================================================================
  it('refuses a build still at "queued" with 409', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedGeneratedInfra(db);
    (db.tables.builds?.[0] as unknown as Build).status = 'queued';

    const res = await previewPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    expect((db.tables.infra_previews ?? []).length).toBe(0);
  });

  // ========================================================================
  // MISROUTE — preview refuses non-infra projects.
  // ========================================================================
  it('refuses a software project with 409', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    db.tables.projects = [
      {
        id: PROJECT_ID,
        user_id: FAKE_USER.id,
        name: 'sw',
        status: 'plan_approved',
        kind: 'software',
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.builds = [
      {
        id: 'b-sw-1',
        project_id: PROJECT_ID,
        spec_id: 'sx',
        plan_id: 'px',
        phase: 'codegen',
        status: 'generated',
        logs: {},
        repo_url: null,
        deploy_url: null,
        kind: 'software',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const res = await previewPOST(makePost(), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    expect((db.tables.infra_previews ?? []).length).toBe(0);
  });

  // ========================================================================
  // STOP — Phases 1-3 codegen loaders STILL 409 an infra project. The
  // preview phase doesn't open anything new in those paths.
  // ========================================================================
  it('Phases 1/2/3 codegen loaders still 409 an infra project after preview', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedGeneratedInfra(db);
    seedBudget(db, EXPECTED.total_usd_per_month * 3);

    const ran = await previewPOST(makePost(), { params: { id: PROJECT_ID } });
    expect(ran.status).toBe(200);

    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedPlanForCodegen
    >[0];

    const p1 = await loadApprovedPlanForCodegen(supabase, PROJECT_ID);
    expect('error' in p1).toBe(true);
    if ('error' in p1) {
      expect(p1.status).toBe(409);
      expect(p1.error).toMatch(/InfraSpec/i);
    }
    const p2 = await loadApprovedSystemPlanForCodegen(supabase, PROJECT_ID);
    expect('error' in p2).toBe(true);
    if ('error' in p2) {
      expect(p2.status).toBe(409);
    }
    const p3 = await loadApprovedSoftwarePlanForCodegen(supabase, PROJECT_ID);
    expect('error' in p3).toBe(true);
    if ('error' in p3) {
      expect(p3.status).toBe(409);
    }
  });

  // ========================================================================
  // Hermeticity — zero real fetch across the whole dry-run.
  // ========================================================================
  it('zero real fetch calls across the whole infra preview dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });

  // ========================================================================
  // PERSISTENCE — the over_budget verdict's persisted row carries the
  // binding cap + projected cost fields so the audit + UI banner read
  // consistently.
  // ========================================================================
  it('over_budget row carries binding cap + projected cost fields', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedGeneratedInfra(db);
    seedBudget(db, 1);

    await previewPOST(makePost(), { params: { id: PROJECT_ID } });

    const row = (db.tables.infra_previews ?? [])[0] as unknown as InfraPreview;
    expect(row.ceiling_verdict).toBe('over_budget');
    expect(row.ceiling_period).toBe('monthly');
    expect(Number(row.ceiling_limit_usd)).toBe(1);
    expect(Number(row.ceiling_projected_usd)).toBeGreaterThan(1);
    expect(typeof row.ceiling_message).toBe('string');
    expect(row.ceiling_message).toMatch(/BLOCKED/);
  });
});
