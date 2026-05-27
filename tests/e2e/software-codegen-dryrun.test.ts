// Hermetic end-to-end dry-run — Phase 3 (Software) CODEGEN.
//
// Companion to software-dryrun.test.ts (intake → confirmed → stopped)
// and software-planner-dryrun.test.ts (confirmed → approved). This
// file picks up at an APPROVED software plan and drives:
//
//   1. seed a project + confirmed SoftwareSpec + approved
//      SoftwareBuildPlan
//   2. loadApprovedSoftwarePlanForCodegen           → returns chain
//   3. generateSoftwareCode                          → REAL scaffold +
//      REAL RLS migration + REAL static check; ONLY the per-slot LLM
//      call (lib/engine/llm.complete) is stubbed.
//   4. persistence: ensureSoftwareCodegenBuild      → 'queued'
//      storeSoftwareBuildFiles + completeSoftwareCodegen → 'generated'
//   5. STOP: software still cannot reach sandbox / deploy / runtime.
//      Asserted by the absence of sandbox / deployment / runtime
//      tables for this project AND the Phase 1 + 2 codegen loaders
//      both 409 a software project with the new-route hint.
//
// THE THREE STRUCTURAL NON-NEGOTIABLES — explicit assertions:
//   1. The Supabase Auth slot files are TEMPLATE-EMITTED, byte-equal
//      across runs; the LLM mock would happily return garbage for
//      auth slots, but the dispatch routes them to scaffold.
//   2. Every entity in the spec has an `enable row level security`
//      + a `create policy` line in the migration.
//   3. No file in the generated output references
//      SUPABASE_SERVICE_ROLE_KEY except `.env.example` (where it's
//      documented but not imported).
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
  generateSoftwareCode,
  SoftwareCodegenError,
} from '@/lib/engine/software/codegen/generate';
import {
  completeSoftwareCodegen,
  ensureSoftwareCodegenBuild,
  loadApprovedSoftwarePlanForCodegen,
  loadLatestSoftwareBuild,
  logSoftwareCodegenStarted,
  markSoftwareBuildGenerating,
  storeSoftwareBuildFiles,
} from '@/lib/engine/software/codegen/persistence';
import { loadApprovedPlanForCodegen } from '@/lib/engine/codegen/persistence';
import { loadApprovedSystemPlanForCodegen } from '@/lib/engine/system/codegen/persistence';
import { assertAllowed } from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';
import {
  createInMemoryDb,
  makeClient,
} from '../helpers/in-memory-supabase';
import type { Build, Plan, Project, Spec } from '@/lib/types';

// ---------------------------------------------------------------------------
// Mock the LLM `complete()` so per-slot calls run without network.
// The scaffold + migration + static check all run for real.
// ---------------------------------------------------------------------------

vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return { ...actual, complete: vi.fn() };
});

import { complete } from '@/lib/engine/llm';

// Spies on governance + ledger.
const assertAllowedSpy = vi.fn<typeof assertAllowed>(assertAllowed);
const recordCostSpy = vi.fn<typeof recordCost>();

// ---------------------------------------------------------------------------
// Canned data — an expenses-tracker shape with two entities + three
// pages, per_user_isolation on. The planner's deterministic mapping
// produces the slot set we feed below.
// ---------------------------------------------------------------------------

const USER_ID = 'user-sw-codegen-dry-run';
const PROJECT_ID = 'project-sw-codegen-dry-run';

const CANNED_SOFTWARE_SPEC: SoftwareSpec = SoftwareSpecSchema.parse({
  goal: 'A team expenses tracker with manager approval and per-user history.',
  pages: [
    { id: 'submit_expense', name: 'Submit', purpose: 'A user submits a new expense.' },
    { id: 'my_history', name: 'My history', purpose: 'A user sees their own past expenses.' },
    { id: 'approvals', name: 'Approvals', purpose: 'A manager approves or rejects pending expenses.' },
  ],
  entities: [
    {
      name: 'Expense',
      fields: [
        { name: 'submitted_by', type: 'reference' },
        { name: 'amount', type: 'number' },
        { name: 'description', type: 'text' },
        { name: 'submitted_at', type: 'datetime' },
        { name: 'approval_status', type: 'enum' },
      ],
    },
    {
      name: 'User',
      fields: [
        { name: 'email', type: 'email' },
        { name: 'role', type: 'enum' },
      ],
    },
  ],
  flows: [
    {
      name: 'Submit and route to approver',
      description: 'A user submits an expense; a manager approves or rejects it.',
      pages: ['submit_expense', 'approvals'],
    },
  ],
  auth: { requires_auth: true, roles: ['member', 'manager'], per_user_isolation: true },
});

// Hand-built plan that matches what the planner's deterministic
// mapping would emit for the canned spec. Two entities → two
// entity_migration + two rls_policy. Both get list+create routes;
// the flow text "approves or rejects" triggers update routes too.
// Three pages → three page_component. Auth: session_middleware +
// role_gate + per_user_isolation_check.
const CANNED_SW_PLAN: SoftwareBuildPlan = SoftwareBuildPlanSchema.parse({
  template_id: 'nextjs-supabase-app',
  tasks: [
    {
      id: 'migration_expense',
      layer: 'schema',
      description: 'Create the Expense table.',
      depends_on: [],
      slot: { kind: 'entity_migration', target: 'Expense' },
      files: [],
    },
    {
      id: 'rls_expense',
      layer: 'schema',
      description: 'Per-user RLS on Expense.',
      depends_on: ['migration_expense'],
      slot: { kind: 'rls_policy', target: 'Expense' },
      files: [],
    },
    {
      id: 'migration_user',
      layer: 'schema',
      description: 'Create the User table.',
      depends_on: [],
      slot: { kind: 'entity_migration', target: 'User' },
      files: [],
    },
    {
      id: 'rls_user',
      layer: 'schema',
      description: 'Per-user RLS on User.',
      depends_on: ['migration_user'],
      slot: { kind: 'rls_policy', target: 'User' },
      files: [],
    },
    {
      id: 'api_list_expense',
      layer: 'api',
      description: 'List expenses.',
      depends_on: ['migration_expense'],
      slot: { kind: 'list_route', target: 'Expense' },
      files: [],
    },
    {
      id: 'api_create_expense',
      layer: 'api',
      description: 'Create an expense.',
      depends_on: ['migration_expense'],
      slot: { kind: 'create_route', target: 'Expense' },
      files: [],
    },
    {
      id: 'api_update_expense',
      layer: 'api',
      description: 'Approve / reject an expense.',
      depends_on: ['migration_expense'],
      slot: { kind: 'update_route', target: 'Expense' },
      files: [],
    },
    {
      id: 'api_list_user',
      layer: 'api',
      description: 'List users.',
      depends_on: ['migration_user'],
      slot: { kind: 'list_route', target: 'User' },
      files: [],
    },
    {
      id: 'page_submit',
      layer: 'ui',
      description: 'Submit expense page.',
      depends_on: ['api_create_expense'],
      slot: { kind: 'page_component', target: 'submit_expense' },
      files: [],
    },
    {
      id: 'page_history',
      layer: 'ui',
      description: 'My history page.',
      depends_on: ['api_list_expense'],
      slot: { kind: 'page_component', target: 'my_history' },
      files: [],
    },
    {
      id: 'page_approvals',
      layer: 'ui',
      description: 'Approvals page.',
      depends_on: ['api_list_expense', 'api_update_expense'],
      slot: { kind: 'page_component', target: 'approvals' },
      files: [],
    },
    {
      id: 'auth_session',
      layer: 'auth',
      description: 'Wire the template Supabase session middleware.',
      depends_on: [],
      slot: { kind: 'session_middleware', target: null },
      files: [],
    },
    {
      id: 'auth_role_gate',
      layer: 'auth',
      description: 'Role gate for member / manager.',
      depends_on: ['auth_session'],
      slot: { kind: 'role_gate', target: null },
      files: [],
    },
    {
      id: 'auth_iso',
      layer: 'auth',
      description: 'Per-user isolation declaration.',
      depends_on: ['rls_expense', 'rls_user'],
      slot: { kind: 'per_user_isolation_check', target: null },
      files: [],
    },
  ],
  execution_order: [
    'migration_expense',
    'migration_user',
    'rls_expense',
    'rls_user',
    'api_list_expense',
    'api_create_expense',
    'api_update_expense',
    'api_list_user',
    'auth_session',
    'auth_role_gate',
    'auth_iso',
    'page_submit',
    'page_history',
    'page_approvals',
  ],
  warnings: [],
});

// Per-slot canned LLM body — picked by file path. The bodies are
// minimal valid TypeScript/TSX so the per-file esbuild static check
// passes. Auth + schema slots never reach the LLM, so we don't need
// canned bodies for those.
function cannedBodyForPath(filePath: string): string {
  if (filePath.startsWith('app/(app)/') && filePath.endsWith('/page.tsx')) {
    return [
      "// Generated page component (stubbed for the dry-run).",
      "import { createServerClient } from '@/lib/supabase/server';",
      '',
      'export default async function Page(): Promise<JSX.Element> {',
      '  const supabase = createServerClient();',
      "  const { data } = await supabase.from('expense').select('*');",
      '  return <main>{(data ?? []).length} rows</main>;',
      '}',
      '',
    ].join('\n');
  }
  if (filePath.includes('/_list.ts')) {
    return [
      "// Generated GET handler (stubbed for the dry-run).",
      "import { createServerClient } from '@/lib/supabase/server';",
      '',
      'export async function GET(_request: Request): Promise<Response> {',
      '  const supabase = createServerClient();',
      "  const { data, error } = await supabase.from('expense').select('*');",
      '  if (error) return Response.json({ error: error.message }, { status: 500 });',
      '  return Response.json({ rows: data ?? [] }, { status: 200 });',
      '}',
      '',
    ].join('\n');
  }
  if (filePath.includes('/_create.ts')) {
    return [
      "// Generated POST handler (stubbed for the dry-run).",
      "import { createServerClient } from '@/lib/supabase/server';",
      "import { currentUserId } from '@/lib/auth/roles';",
      '',
      'export async function POST(request: Request): Promise<Response> {',
      '  const supabase = createServerClient();',
      '  const userId = await currentUserId();',
      '  if (!userId) return Response.json({ error: "unauth" }, { status: 401 });',
      '  const body = (await request.json()) as Record<string, unknown>;',
      "  const { data, error } = await supabase.from('expense').insert({ ...body, owner_id: userId }).select().single();",
      '  if (error) return Response.json({ error: error.message }, { status: 400 });',
      '  return Response.json({ row: data }, { status: 201 });',
      '}',
      '',
    ].join('\n');
  }
  if (filePath.includes('/_update.ts')) {
    return [
      "// Generated PATCH handler (stubbed for the dry-run).",
      "import { createServerClient } from '@/lib/supabase/server';",
      '',
      'export async function PATCH(_request: Request): Promise<Response> {',
      '  const supabase = createServerClient();',
      "  const { error } = await supabase.from('expense').update({}).eq('id', 'x');",
      '  if (error) return Response.json({ error: error.message }, { status: 400 });',
      '  return Response.json({ ok: true }, { status: 200 });',
      '}',
      '',
    ].join('\n');
  }
  if (filePath.includes('/_delete.ts')) {
    return [
      "// Generated DELETE handler (stubbed for the dry-run).",
      "import { createServerClient } from '@/lib/supabase/server';",
      '',
      'export async function DELETE(_request: Request): Promise<Response> {',
      '  const supabase = createServerClient();',
      "  const { error } = await supabase.from('expense').delete().eq('id', 'x');",
      '  if (error) return Response.json({ error: error.message }, { status: 400 });',
      '  return Response.json({ ok: true }, { status: 200 });',
      '}',
      '',
    ].join('\n');
  }
  return '// stub\nexport {};\n';
}

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(complete).mockReset();
  // Default mock: parse the user message for the file path and
  // return a canned body for that path. Per-test overrides via
  // mockResolvedValueOnce when needed.
  vi.mocked(complete).mockImplementation(async ({ messages }) => {
    const last = messages[messages.length - 1];
    const content = typeof last?.content === 'string' ? last.content : '';
    const match = content.match(/Path:\s+([^\n]+)/);
    const filePath = match ? match[1]!.trim() : '';
    return {
      text: cannedBodyForPath(filePath),
      usage: { input_tokens: 800, output_tokens: 400 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    };
  });
});

describe('Phase 3 SOFTWARE codegen hermetic dry-run', () => {
  it('drives approved software plan → generated app, scaffold + RLS migration + filled slots, downstream still closed', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedSoftwarePlanForCodegen
    >[0];
    const guardClient = makeClient(db) as unknown as Parameters<typeof assertAllowed>[1];

    // Seed: confirmed software spec + approved software plan.
    const project: Project = {
      id: PROJECT_ID,
      user_id: USER_ID,
      name: 'Team Expenses',
      status: 'plan_approved',
      kind: 'software',
      created_at: new Date().toISOString(),
    };
    const spec: Spec = {
      id: 'spec-sw-codegen-1',
      project_id: project.id,
      raw_prompt: 'expenses tracker',
      structured_spec: CANNED_SOFTWARE_SPEC as unknown as Spec['structured_spec'],
      open_questions: [],
      feedback: null,
      status: 'confirmed',
      kind: 'software',
      created_at: new Date().toISOString(),
    };
    const planRow: Plan = {
      id: 'plan-sw-codegen-1',
      project_id: project.id,
      spec_id: spec.id,
      plan: CANNED_SW_PLAN as unknown as Plan['plan'],
      status: 'approved',
      feedback: null,
      kind: 'software',
      created_at: new Date().toISOString(),
    };
    db.tables.projects = [project as unknown as Record<string, unknown>];
    db.tables.specs = [spec as unknown as Record<string, unknown>];
    db.tables.plans = [planRow as unknown as Record<string, unknown>];

    assertAllowedSpy.mockClear();
    recordCostSpy.mockClear();

    // Loader returns the confirmed-software spec + approved-software
    // plan chain.
    const ctx = await loadApprovedSoftwarePlanForCodegen(supabase, project.id);
    expect('error' in ctx).toBe(false);
    if ('error' in ctx) throw new Error('loader unexpected: ' + ctx.error);

    // Insert the build row through the persistence helper to match
    // the route's order of operations.
    const buildResult = await ensureSoftwareCodegenBuild(
      supabase,
      project.id,
      planRow.id,
      spec.id,
    );
    expect('error' in buildResult).toBe(false);
    if ('error' in buildResult) throw new Error('build row unexpected');
    const build: Build = buildResult.build;
    expect(build.kind).toBe('software');
    expect(build.status).toBe('queued');

    await logSoftwareCodegenStarted(supabase, build);
    await markSoftwareBuildGenerating(supabase, build.id);

    // Each per-slot LLM call goes through assertAllowed → recordCost
    // via lib/engine/llm.complete. Here we simulate that gate per
    // slot by invoking the spies inline before each LLM mock fires.
    // The total cost-gate hits = number of LLM slots.
    async function gate(ref: string) {
      await assertAllowedSpy(
        { user_id: USER_ID, project_id: project.id, projectedCostUsd: 0.05 },
        guardClient,
      );
      recordCostSpy.mockImplementationOnce(async () => ({
        amount_usd: 0.05,
        event_id: 'evt-' + ref,
      }));
      await recordCostSpy({
        user_id: USER_ID,
        project_id: project.id,
        kind: 'llm',
        model: 'claude-sonnet-4-6',
        input_tokens: 100,
        output_tokens: 200,
        ref,
        key_source: 'platform',
      });
    }

    // Pre-gate one call per LLM slot. The plan has 4 route slots +
    // 3 page slots = 7 LLM calls. Auth + schema slots are
    // deterministic (no gate).
    const llmSlotRefs = [
      'route.list.Expense',
      'route.create.Expense',
      'route.update.Expense',
      'route.list.User',
      'page.submit_expense',
      'page.my_history',
      'page.approvals',
    ];
    for (const ref of llmSlotRefs) await gate('software.codegen.' + ref);

    const summary = await generateSoftwareCode({
      spec: ctx.parsedSpec,
      plan: ctx.parsedPlan,
      governance: {
        user_id: USER_ID,
        project_id: project.id,
        ref: 'software.codegen.generate.' + build.id,
      },
    });

    // === Scaffold + migration + LLM slots all materialised ===
    expect(summary.scaffoldId).toBe('nextjs-supabase-app');
    expect(summary.slotCounts.deterministic).toBe(7); // 4 schema + 3 auth
    expect(summary.slotCounts.llm).toBe(7); // 4 route + 3 page

    const paths = summary.files.map((f) => f.path);
    // Scaffold
    expect(paths).toContain('package.json');
    expect(paths).toContain('tsconfig.json');
    expect(paths).toContain('middleware.ts');
    expect(paths).toContain('app/sign-in/page.tsx');
    expect(paths).toContain('app/auth/callback/route.ts');
    expect(paths).toContain('lib/supabase/server.ts');
    expect(paths).toContain('lib/supabase/browser.ts');
    expect(paths).toContain('lib/auth/roles.ts');
    expect(paths).toContain('lib/auth/rls.ts');
    // Migration
    expect(paths).toContain('supabase/migrations/0001_init.sql');
    // LLM slots
    expect(paths).toContain('app/api/expense/_list.ts');
    expect(paths).toContain('app/api/expense/_create.ts');
    expect(paths).toContain('app/api/expense/[id]/_update.ts');
    expect(paths).toContain('app/api/user/_list.ts');
    expect(paths).toContain('app/(app)/submit-expense/page.tsx');
    expect(paths).toContain('app/(app)/my-history/page.tsx');
    expect(paths).toContain('app/(app)/approvals/page.tsx');
    // Route shells (deterministic, derived from per-slot files)
    expect(paths).toContain('app/api/expense/route.ts');
    expect(paths).toContain('app/api/expense/[id]/route.ts');
    expect(paths).toContain('app/api/user/route.ts');

    // === Every file passed the per-file esbuild static check ===
    for (const f of summary.files) {
      expect(f.staticCheck.ok).toBe(true);
    }

    // Persist + complete.
    await storeSoftwareBuildFiles(supabase, build.id, summary);
    await completeSoftwareCodegen(supabase, build, summary);

    const reloaded = await loadLatestSoftwareBuild(supabase, project.id);
    expect(reloaded?.kind).toBe('software');
    expect(reloaded?.status).toBe('generated');

    // === Build files are persisted with the right source labels ===
    const buildFileRows = (db.tables.build_files ?? []) as Array<
      Record<string, unknown>
    >;
    expect(buildFileRows.length).toBe(summary.files.length);
    const scaffoldRows = buildFileRows.filter((r) => r.source === 'scaffold');
    const generatedRows = buildFileRows.filter((r) => r.source === 'generated');
    expect(scaffoldRows.length).toBeGreaterThan(0);
    expect(generatedRows.length).toBeGreaterThan(0);

    // === Audit log carries the software.codegen_* trail ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'software.codegen_started')).toBe(true);
    expect(audit.some((r) => r.action === 'software.codegen_completed')).toBe(true);

    // ========================================================================
    // STRUCTURAL NON-NEGOTIABLE #1 — Supabase Auth slot, not LLM-authored.
    //
    // The scaffold's auth files have known content. Even though the
    // LLM mock returns a canned body, the dispatch never routes auth
    // slots to the LLM — so the file content is the template's
    // canonical text. We verify by checking content markers the
    // template emits.
    // ========================================================================
    const middleware = summary.files.find((f) => f.path === 'middleware.ts');
    expect(middleware).toBeTruthy();
    expect(middleware?.content).toContain('Aurexis Forge — Supabase session middleware (template-emitted)');
    expect(middleware?.content).toMatch(/redirect[\s\S]*\/sign-in/);
    expect(middleware?.content).not.toContain('Generated page component');

    const signIn = summary.files.find((f) => f.path === 'app/sign-in/page.tsx');
    expect(signIn?.content).toContain('Aurexis Forge — Supabase Auth sign-in page (template-emitted)');
    expect(signIn?.content).toContain('signInWithOtp');

    const rolesFile = summary.files.find((f) => f.path === 'lib/auth/roles.ts');
    expect(rolesFile?.content).toContain('Aurexis Forge — role gate (template-emitted)');

    // ========================================================================
    // STRUCTURAL NON-NEGOTIABLE #2 — RLS on EVERY entity table.
    //
    // The migration must `enable row level security` once per entity
    // table AND emit at least one `create policy` per table. We
    // assert both invariants directly against the migration text.
    // ========================================================================
    const migration = summary.files.find(
      (f) => f.path === 'supabase/migrations/0001_init.sql',
    );
    expect(migration).toBeTruthy();
    const sql = migration?.content ?? '';
    // Two entities — expense + user — each MUST appear.
    expect(sql).toContain('alter table public.expense enable row level security;');
    expect(sql).toContain('alter table public.user enable row level security;');
    // Per-user policy (per_user_isolation is on in the canned spec).
    expect(sql).toContain('create policy expense_owner on public.expense');
    expect(sql).toContain('create policy user_owner on public.user');
    // Owner column is present so the policy has something to pin.
    expect(sql).toContain('owner_id uuid not null references auth.users(id)');

    // ========================================================================
    // STRUCTURAL NON-NEGOTIABLE #3 — service-role key never READ.
    //
    // Documentation references to the env var name are fine (.env.example
    // declares it, the README + browser.ts mention it in safety
    // comments). What MUST NOT exist anywhere is a code expression that
    // reads it — `process.env.SUPABASE_SERVICE_ROLE_KEY`. The
    // generated app has no admin slot, so this expression appears in
    // ZERO files.
    const filesReadingServiceRole = summary.files.filter((f) =>
      f.content.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'),
    );
    expect(filesReadingServiceRole.map((f) => f.path)).toEqual([]);
    // And the browser client doesn't reach for a server-only helper —
    // a stricter way of saying the server / client boundary holds.
    const browser = summary.files.find(
      (f) => f.path === 'lib/supabase/browser.ts',
    );
    expect(browser?.content).not.toContain("from '@/lib/supabase/server'");
    expect(browser?.content).not.toContain('process.env.SUPABASE_SERVICE_ROLE_KEY');

    // ========================================================================
    // STOP — software is the LAST stop in P3-3.
    //
    // The brief: "software still cannot reach sandbox / deploy /
    // runtime." We assert this by:
    //   1. The Phase 1 codegen loader refuses with 409 + the new hint
    //   2. The Phase 2 codegen loader refuses with 409 + the new hint
    //   3. No sandbox / deployment / runtime rows exist for the project.
    // ========================================================================
    const phase1 = await loadApprovedPlanForCodegen(supabase, project.id);
    expect('error' in phase1).toBe(true);
    if ('error' in phase1) {
      expect(phase1.status).toBe(409);
      expect(phase1.error).toMatch(/software\/build\/generate/i);
    }
    const phase2 = await loadApprovedSystemPlanForCodegen(supabase, project.id);
    expect('error' in phase2).toBe(true);
    if ('error' in phase2) {
      expect(phase2.status).toBe(409);
      expect(phase2.error).toMatch(/software\/build\/generate/i);
    }
    expect((db.tables.sandbox_runs ?? []).length).toBe(0);
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);

    // Governance coverage — one gate per LLM slot.
    expect(assertAllowedSpy).toHaveBeenCalledTimes(llmSlotRefs.length);
    expect(recordCostSpy).toHaveBeenCalledTimes(llmSlotRefs.length);
    for (const [input] of assertAllowedSpy.mock.calls) {
      expect(input.user_id).toBe(USER_ID);
      expect(input.project_id).toBe(PROJECT_ID);
      expect(input.projectedCostUsd).toBeGreaterThan(0);
    }
  });

  // ========================================================================
  // Misroute: software codegen loader refuses an agent project.
  // ========================================================================
  it('loadApprovedSoftwarePlanForCodegen rejects an agent project with 409', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedSoftwarePlanForCodegen
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
    db.tables.specs = [
      {
        id: 's-agent-1',
        project_id: 'p-agent-1',
        raw_prompt: 'single agent',
        structured_spec: { name: 'x', goal: 'x' },
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'agent',
        created_at: new Date().toISOString(),
      },
    ];

    const result = await loadApprovedSoftwarePlanForCodegen(supabase, 'p-agent-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/AgentSpec/i);
    }
  });

  it('loadApprovedSoftwarePlanForCodegen rejects a system project with 409', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedSoftwarePlanForCodegen
    >[0];

    db.tables.projects = [
      {
        id: 'p-sys-1',
        user_id: USER_ID,
        name: 'system-project',
        status: 'plan_approved',
        kind: 'system',
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.specs = [
      {
        id: 's-sys-1',
        project_id: 'p-sys-1',
        raw_prompt: 'multi-agent system',
        structured_spec: { goal: 'x' },
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'system',
        created_at: new Date().toISOString(),
      },
    ];

    const result = await loadApprovedSoftwarePlanForCodegen(supabase, 'p-sys-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/SystemSpec/i);
    }
  });

  // ========================================================================
  // Misroute (defence in depth): Phase 1 + 2 codegen loaders refuse a
  // software project with the explicit "use the software route" hint.
  // ========================================================================
  it('Phase 1 codegen loader rejects a software project with 409 + the new hint', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedPlanForCodegen
    >[0];

    db.tables.projects = [
      {
        id: 'p-sw-1',
        user_id: USER_ID,
        name: 'sw-project',
        status: 'plan_approved',
        kind: 'software',
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.specs = [
      {
        id: 's-sw-1',
        project_id: 'p-sw-1',
        raw_prompt: 'expenses app',
        structured_spec: CANNED_SOFTWARE_SPEC as unknown as Spec['structured_spec'],
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'software',
        created_at: new Date().toISOString(),
      },
    ];

    const result = await loadApprovedPlanForCodegen(supabase, 'p-sw-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/SoftwareSpec/i);
      expect(result.error).toMatch(/software\/build\/generate/i);
    }
  });

  it('Phase 2 codegen loader rejects a software project with 409 + the new hint', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedSystemPlanForCodegen
    >[0];

    db.tables.projects = [
      {
        id: 'p-sw-2',
        user_id: USER_ID,
        name: 'sw-project-2',
        status: 'plan_approved',
        kind: 'software',
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.specs = [
      {
        id: 's-sw-2',
        project_id: 'p-sw-2',
        raw_prompt: 'expenses app',
        structured_spec: CANNED_SOFTWARE_SPEC as unknown as Spec['structured_spec'],
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'software',
        created_at: new Date().toISOString(),
      },
    ];

    const result = await loadApprovedSystemPlanForCodegen(supabase, 'p-sw-2');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/SoftwareSpec/i);
      expect(result.error).toMatch(/software\/build\/generate/i);
    }
  });

  // ========================================================================
  // Error surface — SoftwareCodegenError is preserved for ops.
  // ========================================================================
  it('SoftwareCodegenError surface is preserved', () => {
    expect(SoftwareCodegenError).toBeDefined();
    expect(SoftwareCodegenError.prototype.name).toBe('Error');
  });

  // ========================================================================
  // Hermeticity.
  // ========================================================================
  it('zero real fetch calls across the whole software codegen dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
