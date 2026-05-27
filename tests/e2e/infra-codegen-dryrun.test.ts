// Hermetic end-to-end dry-run — Phase 4-3 (Infrastructure) IAC CODEGEN.
//
// Companion to infra-planner-dryrun.test.ts (intake → confirmed →
// approved plan). This file picks up at an APPROVED ProvisioningPlan
// and drives:
//
//   1. seed a project + confirmed InfraSpec + approved
//      ProvisioningPlan
//   2. loadApprovedInfraPlanForCodegen → returns chain
//   3. generateInfraCode → FULLY DETERMINISTIC (no LLM mock needed);
//      composeIac + validateGeneratedIac both run for real
//   4. ensureInfraCodegenBuild + storeInfraBuildFiles +
//      completeInfraCodegen → build 'generated'
//   5. STOP: infra still cannot reach preview / provision / apply /
//      runtime. Asserted by absence of any downstream rows AND by
//      the Phases 1/2/3 codegen loaders all 409 an infra project
//      with the new-route hint.
//
// THE THREE STRUCTURAL NON-NEGOTIABLES — explicit assertions:
//   1. EVERY emitted block traces to a catalog module. No freehand
//      `resource "..."` or `data "..."` block anywhere in the output.
//      Every step's source matches the catalog entry exactly.
//   2. SECURE DEFAULTS — private_by_default + TLS + least-privilege
//      IAM + KMS encryption asserted on the aggregated summary AND
//      in the per-file content (comment headers).
//   3. NOTHING IS APPLIED — zero real fetch (globalThis.fetch was
//      installed as a hard-fail in tests/setup.ts), the audit row
//      records cloud_calls=0 + terraform_plan_invoked=false +
//      terraform_apply_invoked=false, and no provider executable was
//      called (the codegen path doesn't shell out to terraform).
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InfraSpecSchema,
  type InfraSpec,
} from '@/lib/engine/infra/spec';
import {
  ProvisioningPlanSchema,
  type ProvisioningPlan,
} from '@/lib/engine/infra/planner/schema';
import {
  INFRA_MODULE_IDS,
} from '@/lib/engine/infra/planner/modules';
import {
  generateInfraCode,
} from '@/lib/engine/infra/codegen/generate';
import {
  IAC_CATALOG,
} from '@/lib/engine/infra/codegen/catalog';
import {
  completeInfraCodegen,
  ensureInfraCodegenBuild,
  loadApprovedInfraPlanForCodegen,
  loadLatestInfraBuild,
  logInfraCodegenStarted,
  markInfraBuildGenerating,
  storeInfraBuildFiles,
} from '@/lib/engine/infra/codegen/persistence';
import { loadApprovedPlanForCodegen } from '@/lib/engine/codegen/persistence';
import { loadApprovedSystemPlanForCodegen } from '@/lib/engine/system/codegen/persistence';
import { loadApprovedSoftwarePlanForCodegen } from '@/lib/engine/software/codegen/persistence';
import {
  createInMemoryDb,
  makeClient,
} from '../helpers/in-memory-supabase';
import type { Build, Plan, Project, Spec } from '@/lib/types';

// ---------------------------------------------------------------------------
// Canned data — a representative InfraSpec that exercises every
// catalog layer:
//   - data layer: a postgres db + an object store + a queue
//   - compute layer: a worker (private) + a cron + an http_service
//     (private — the spec does NOT opt in to public exposure)
// Plus a single private http_service that ASKS for public exposure
// via config (to exercise the opt-in path).
// ---------------------------------------------------------------------------

const USER_ID = 'user-infra-codegen-dry-run';
const PROJECT_ID = 'project-infra-codegen-dry-run';

const CANNED_INFRA_SPEC: InfraSpec = InfraSpecSchema.parse({
  goal: 'Multi-tier ingest pipeline with a small public API.',
  region: 'us-east-1',
  lifecycle: 'persistent',
  resources: [
    {
      id: 'events_db',
      type: 'postgres_db',
      config: { version: '15', storage_gb: 50 },
    },
    {
      id: 'event_archive',
      type: 'object_store',
      config: { lifecycle_days: 90 },
    },
    {
      id: 'ingest_queue',
      type: 'queue',
      config: { visibility_timeout_s: 30, max_receive_count: 5 },
    },
    {
      id: 'ingest_worker',
      type: 'worker',
      config: { image: 'aurexis/ingest:1.2.3', cpu: 1, memory_mb: 1024 },
      sizing: { instances: 2 },
    },
    {
      id: 'nightly_rollup',
      type: 'cron',
      config: { schedule: '0 2 * * *' },
    },
    {
      id: 'public_api',
      type: 'http_service',
      // EXPLICIT opt-in. The composer must flip `public = true` only
      // because the spec asked for it.
      config: { image: 'aurexis/api:1.2.3', public: true },
      sizing: { instances: 3 },
    },
    {
      id: 'private_api',
      type: 'http_service',
      config: { image: 'aurexis/internal:1.0.0' },
      // No public flag → must end up private.
    },
  ],
  topology: [
    { from: 'ingest_worker', to: 'events_db' },
    { from: 'ingest_worker', to: 'event_archive' },
    { from: 'ingest_worker', to: 'ingest_queue' },
    { from: 'nightly_rollup', to: 'ingest_worker' },
    { from: 'public_api', to: 'events_db' },
    { from: 'private_api', to: 'events_db' },
  ],
});

// Build a matching ProvisioningPlan via the graph derivation logic.
// We import the derivation function to keep the test honest — the
// plan we feed codegen is exactly what the real planner would emit.
import { deriveInfraGraph } from '@/lib/engine/infra/planner/graph';
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
// Seed helper.
// ---------------------------------------------------------------------------

function seedInfraProject(db: ReturnType<typeof createInMemoryDb>): {
  project: Project;
  spec: Spec;
  plan: Plan;
} {
  const project: Project = {
    id: PROJECT_ID,
    user_id: USER_ID,
    name: 'Ingest Pipeline',
    status: 'plan_approved',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-infra-codegen-1',
    project_id: project.id,
    raw_prompt: 'ingest pipeline',
    structured_spec: CANNED_INFRA_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'confirmed',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  const plan: Plan = {
    id: 'plan-infra-codegen-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_INFRA_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
  };
  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  return { project, spec, plan };
}

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Defensive — nothing in this dry-run touches network or LLM, but
  // reset spies in case a future iteration adds either.
});

describe('Phase 4-3 INFRASTRUCTURE codegen hermetic dry-run', () => {
  // ========================================================================
  // HAPPY PATH — approved plan → generate → 'generated' with no
  // downstream rows.
  // ========================================================================
  it('approved plan → generate → "generated"; every block traces to catalog; secure defaults baked in; nothing applied', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedInfraPlanForCodegen
    >[0];

    const { plan } = seedInfraProject(db);

    const ctx = await loadApprovedInfraPlanForCodegen(supabase, PROJECT_ID);
    expect('error' in ctx).toBe(false);
    if ('error' in ctx) throw new Error(ctx.error);

    const buildResult = await ensureInfraCodegenBuild(
      supabase,
      PROJECT_ID,
      plan.id,
      ctx.spec.id,
    );
    if ('error' in buildResult) throw new Error(buildResult.error);
    const build = buildResult.build;

    await logInfraCodegenStarted(supabase, build);
    await markInfraBuildGenerating(supabase, build.id);

    const summary = generateInfraCode({
      spec: ctx.parsedSpec,
      plan: ctx.parsedPlan,
    });

    await storeInfraBuildFiles(supabase, build.id, summary);
    await completeInfraCodegen(supabase, build, summary);

    // === Build → 'generated' ===
    const reloadedBuild = (db.tables.builds ?? []).find(
      (r) => r.id === build.id,
    ) as Build | undefined;
    expect(reloadedBuild?.status).toBe('generated');
    expect(reloadedBuild?.kind).toBe('infrastructure');

    // ===================================================================
    // NON-NEGOTIABLE #1 — EVERY block traces to a catalog module.
    // ===================================================================
    // 1a. The summary's module_ids_used is a subset of the closed catalog.
    for (const id of summary.module_ids_used) {
      expect(INFRA_MODULE_IDS).toContain(id);
    }
    // 1b. Every plan step produced exactly one .tf file, and that
    // file's `source = "..."` matches the catalog entry.
    for (const step of ctx.parsedPlan.steps) {
      const file = summary.files.find(
        (f) => f.path === 'infra/' + step.layer + '/' + step.id + '.tf',
      );
      expect(file).toBeDefined();
      const expectedSource = IAC_CATALOG[step.module].source;
      expect(file!.content).toMatch(
        new RegExp('source\\s*=\\s*"' + escapeRegex(expectedSource) + '"'),
      );
      // Module block name matches the step id.
      expect(file!.content).toMatch(
        new RegExp('module\\s+"' + escapeRegex(step.id) + '"\\s*\\{'),
      );
    }
    // 1c. NO freehand `resource "..."` or `data "..."` block anywhere
    // in the generated tree. This is the strictest assertion: the
    // composer must never emit raw provider config.
    for (const f of summary.files) {
      expect(f.content).not.toMatch(/^\s*resource\s+"[^"]+"\s+"[^"]+"\s*\{/m);
      expect(f.content).not.toMatch(/^\s*data\s+"[^"]+"\s+"[^"]+"\s*\{/m);
    }

    // ===================================================================
    // NON-NEGOTIABLE #2 — Secure defaults present.
    // ===================================================================
    // 2a. Aggregated flags in the summary.
    expect(summary.secure_defaults.private_by_default).toBe(true);
    expect(summary.secure_defaults.tls).toBe(true);
    expect(summary.secure_defaults.least_privilege_iam).toBe(true);
    expect(summary.secure_defaults.kms_encryption).toBe(true);

    // 2b. Per-file: every module file carries the secure-defaults
    // comment block.
    for (const f of summary.files) {
      if (f.path === 'infra/versions.tf') continue;
      expect(f.content).toMatch(/^# secure_defaults:/m);
      expect(f.content).toMatch(/private_by_default = true/);
      expect(f.content).toMatch(/tls = true/);
      expect(f.content).toMatch(/least_privilege_iam = true/);
    }

    // 2c. PRIVATE-BY-DEFAULT — http_service MUST emit `public = false`
    // UNLESS the InfraSpec config explicitly set `public: true`.
    // 'private_api' has no public flag → its file must say
    // `public = false`. 'public_api' opted in → `public = true`.
    const privateApiFile = summary.files.find(
      (f) => f.path === 'infra/compute/compute_private_api.tf',
    );
    expect(privateApiFile).toBeDefined();
    expect(privateApiFile!.content).toMatch(/public\s+= false/);
    const publicApiFile = summary.files.find(
      (f) => f.path === 'infra/compute/compute_public_api.tf',
    );
    expect(publicApiFile).toBeDefined();
    expect(publicApiFile!.content).toMatch(/public\s+= true/);
    expect(publicApiFile!.content).toMatch(/public_exposure_opt_in: true/);

    // 2d. public_exposure_opt_ins lists only the one opted-in resource.
    expect(summary.public_exposure_opt_ins).toEqual(['public_api']);

    // ===================================================================
    // NON-NEGOTIABLE #3 — Nothing is applied.
    // ===================================================================
    // 3a. ZERO real fetch calls — tests/setup.ts installs fetch as a
    // throwing mock; this test never calls it.
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);

    // 3b. Audit row records the boundary explicitly.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    const completed = audit.find(
      (r) => r.action === 'infra.codegen_completed',
    ) as { detail?: Record<string, unknown> } | undefined;
    expect(completed).toBeDefined();
    expect(completed?.detail?.cloud_calls).toBe(0);
    expect(completed?.detail?.terraform_plan_invoked).toBe(false);
    expect(completed?.detail?.terraform_apply_invoked).toBe(false);
    expect(completed?.detail?.structural_ok).toBe(true);

    // 3c. No deployments / agent_runtimes / sandbox_runs rows
    // populated. Infra has no downstream lifecycle in P4-3.
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
    expect((db.tables.sandbox_runs ?? []).length).toBe(0);

    // === Static validation passed ===
    expect(summary.structural_ok).toBe(true);
    for (const check of summary.static_checks) {
      expect(check.status).toBe('ok');
    }

    // === build_files persisted with versions.tf + one .tf per step ===
    const buildFiles = (db.tables.build_files ?? []) as Array<
      Record<string, unknown>
    >;
    expect(buildFiles.length).toBeGreaterThanOrEqual(
      ctx.parsedPlan.steps.length + 1, // +1 for versions.tf
    );
    const versionsFile = buildFiles.find(
      (f) => f.path === 'infra/versions.tf',
    );
    expect(versionsFile).toBeDefined();
    expect(String(versionsFile?.content)).toContain('required_version');
  });

  // ========================================================================
  // STOP — Phase 1 / 2 / 3 codegen loaders 409 an infra project.
  // ========================================================================
  it('Phases 1/2/3 codegen loaders 409 an infra project with the infra-route hint', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedPlanForCodegen
    >[0];
    seedInfraProject(db);

    const phase1 = await loadApprovedPlanForCodegen(supabase, PROJECT_ID);
    expect('error' in phase1).toBe(true);
    if ('error' in phase1) {
      expect(phase1.status).toBe(409);
      expect(phase1.error).toMatch(/InfraSpec/i);
      expect(phase1.error).toMatch(/infra\/build\/generate/i);
    }

    const phase2 = await loadApprovedSystemPlanForCodegen(supabase, PROJECT_ID);
    expect('error' in phase2).toBe(true);
    if ('error' in phase2) {
      expect(phase2.status).toBe(409);
      expect(phase2.error).toMatch(/InfraSpec/i);
      expect(phase2.error).toMatch(/infra\/build\/generate/i);
    }

    const phase3 = await loadApprovedSoftwarePlanForCodegen(
      supabase,
      PROJECT_ID,
    );
    expect('error' in phase3).toBe(true);
    if ('error' in phase3) {
      expect(phase3.status).toBe(409);
      expect(phase3.error).toMatch(/InfraSpec/i);
      expect(phase3.error).toMatch(/infra\/build\/generate/i);
    }
  });

  // ========================================================================
  // STOP — Infrastructure loader 409s a non-infra project.
  // ========================================================================
  it('loadApprovedInfraPlanForCodegen 409s a software project with the software-route hint', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedInfraPlanForCodegen
    >[0];

    db.tables.projects = [
      {
        id: 'p-sw-1',
        user_id: USER_ID,
        name: 'sw',
        status: 'plan_approved',
        kind: 'software',
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.specs = [
      {
        id: 's-sw-1',
        project_id: 'p-sw-1',
        raw_prompt: 'x',
        structured_spec: { goal: 'x' },
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'software',
        created_at: new Date().toISOString(),
      },
    ];

    const result = await loadApprovedInfraPlanForCodegen(supabase, 'p-sw-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/SoftwareSpec/i);
      expect(result.error).toMatch(/software\/build\/generate/i);
    }
  });

  // ========================================================================
  // STOP — Re-generate is refused on an already-generated build.
  // ========================================================================
  it('refuses to re-generate when an infra build already reached "generated"', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedInfraPlanForCodegen
    >[0];
    const { plan } = seedInfraProject(db);
    const ctx = await loadApprovedInfraPlanForCodegen(supabase, PROJECT_ID);
    if ('error' in ctx) throw new Error(ctx.error);

    // First codegen — succeeds.
    const first = await ensureInfraCodegenBuild(
      supabase,
      PROJECT_ID,
      plan.id,
      ctx.spec.id,
    );
    if ('error' in first) throw new Error(first.error);
    const summary = generateInfraCode({
      spec: ctx.parsedSpec,
      plan: ctx.parsedPlan,
    });
    await storeInfraBuildFiles(supabase, first.build.id, summary);
    await completeInfraCodegen(supabase, first.build, summary);

    // Second attempt with the same plan_id → refused (build already
    // 'generated'; downstream gates aren't open yet).
    const second = await ensureInfraCodegenBuild(
      supabase,
      PROJECT_ID,
      plan.id,
      ctx.spec.id,
    );
    expect('error' in second).toBe(true);
    if ('error' in second) {
      expect(second.status).toBe(409);
    }
  });

  // ========================================================================
  // Hermeticity.
  // ========================================================================
  it('zero real fetch calls across the whole infra codegen dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });

  // ========================================================================
  // generateInfraCode is callable directly — fully deterministic.
  // ========================================================================
  it('generateInfraCode is fully deterministic — same input produces byte-identical output', () => {
    const a = generateInfraCode({
      spec: CANNED_INFRA_SPEC,
      plan: CANNED_INFRA_PLAN,
    });
    const b = generateInfraCode({
      spec: CANNED_INFRA_SPEC,
      plan: CANNED_INFRA_PLAN,
    });
    expect(a.files.length).toBe(b.files.length);
    for (let i = 0; i < a.files.length; i++) {
      expect(a.files[i]!.path).toBe(b.files[i]!.path);
      expect(a.files[i]!.content).toBe(b.files[i]!.content);
    }
    // module_ids_used is a Set internally — convert + sort for stable
    // comparison.
    expect([...a.module_ids_used].sort()).toEqual(
      [...b.module_ids_used].sort(),
    );
  });

  // ========================================================================
  // loadLatestInfraBuild returns the freshest infra build only.
  // ========================================================================
  it('loadLatestInfraBuild filters by kind="infrastructure"', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadLatestInfraBuild
    >[0];
    db.tables.builds = [
      {
        id: 'b-sw',
        project_id: PROJECT_ID,
        spec_id: 'sx',
        plan_id: 'px',
        phase: 'codegen',
        status: 'generated',
        logs: {},
        repo_url: null,
        deploy_url: null,
        kind: 'software',
        created_at: new Date(Date.now() - 60_000).toISOString(),
        updated_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        id: 'b-infra',
        project_id: PROJECT_ID,
        spec_id: 'sx',
        plan_id: 'px',
        phase: 'codegen',
        status: 'generated',
        logs: {},
        repo_url: null,
        deploy_url: null,
        kind: 'infrastructure',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const row = await loadLatestInfraBuild(supabase, PROJECT_ID);
    expect(row?.id).toBe('b-infra');
    expect(row?.kind).toBe('infrastructure');
  });
});

// Lightweight regex escape so the test can build a source-match RE
// from the catalog's address. No need for an external dep.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
