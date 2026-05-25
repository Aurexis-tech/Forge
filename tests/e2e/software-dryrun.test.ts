// Hermetic end-to-end dry-run — Phase 3 SOFTWARE path.
//
// Mirrors tests/e2e/system-dryrun.test.ts. Drives a single project
// through:
//   1. classify (stubbed)        → kind='software'
//   2. extract  (stubbed)        → canned valid SoftwareSpec
//   3. confirmSoftwareSpec       → real gate, advances to confirmed
//   4. STOP                      → both planner loaders (Phase 1 + Phase 2)
//                                  return 409 "review-only in this phase"
//                                  for kind='software'.
//
// NO real network. NO real DB. NO real spend.

import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  SoftwareSpecSchema,
  type SoftwareSpec,
} from '@/lib/engine/software/spec';
import {
  confirmSoftwareSpec,
  persistSoftwareExtractionResult,
} from '@/lib/engine/software/persistence';
import { loadProjectWithConfirmedSpec } from '@/lib/engine/planner/persistence';
import { loadProjectWithConfirmedSystemSpec } from '@/lib/engine/system/planner/persistence';
import { assertAllowed } from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';
import {
  createInMemoryDb,
  makeClient,
} from '../helpers/in-memory-supabase';
import type { Project, Spec } from '@/lib/types';

// ---------------------------------------------------------------------------
// Mocks — same engine-function boundary as the agent + system dry-runs.
// ---------------------------------------------------------------------------

vi.mock('@/lib/engine/classify/classify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/classify/classify')>();
  return { ...actual, classifyIntake: vi.fn() };
});
vi.mock('@/lib/engine/software/extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/software/extract')>();
  return { ...actual, extractSoftwareSpec: vi.fn() };
});

import { classifyIntake } from '@/lib/engine/classify/classify';
import { extractSoftwareSpec } from '@/lib/engine/software/extract';

const assertAllowedSpy = vi.fn<typeof assertAllowed>(assertAllowed);
const recordCostSpy = vi.fn<typeof recordCost>();

const USER_ID = 'user-sw-dry-run';
const PROJECT_ID = 'project-sw-dry-run';

const CANNED_SW_SPEC: SoftwareSpec = SoftwareSpecSchema.parse({
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
      description: 'A user submits an expense; it lands in their manager’s approvals queue.',
      pages: ['submit_expense', 'approvals'],
    },
  ],
  auth: { requires_auth: true, roles: ['member', 'manager'], per_user_isolation: true },
});

function seedProject(db: ReturnType<typeof createInMemoryDb>): Project {
  const project: Project = {
    id: PROJECT_ID,
    user_id: USER_ID,
    name: 'Team Expenses',
    status: 'draft',
    kind: 'agent', // starts default; classifier + persistence flip to 'software'
    created_at: new Date().toISOString(),
  };
  if (!db.tables.projects) db.tables.projects = [];
  db.tables.projects.push(project as unknown as Record<string, unknown>);
  return project;
}

function seedSpec(
  db: ReturnType<typeof createInMemoryDb>,
  project: Project,
): Spec {
  const spec: Spec = {
    id: 'spec-sw-1',
    project_id: project.id,
    raw_prompt:
      'A web app where my team submits and tracks expenses, a manager approves them, and everyone sees their own history.',
    structured_spec: null,
    open_questions: null,
    feedback: null,
    status: 'pending',
    kind: 'agent',
    created_at: new Date().toISOString(),
  };
  if (!db.tables.specs) db.tables.specs = [];
  db.tables.specs.push(spec as unknown as Record<string, unknown>);
  return spec;
}

afterAll(() => {
  vi.restoreAllMocks();
});

describe('Phase 3 SOFTWARE hermetic dry-run', () => {
  it('drives a software project intake → confirmed-and-stopped, with both planner loaders enforcing 409', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof persistSoftwareExtractionResult
    >[0]['supabase'];
    const guardClient = makeClient(db) as unknown as Parameters<typeof assertAllowed>[1];

    const project = seedProject(db);
    const spec = seedSpec(db, project);

    assertAllowedSpy.mockClear();
    recordCostSpy.mockClear();

    async function gate(projectedCostUsd: number, ref: string) {
      await assertAllowedSpy(
        { user_id: USER_ID, project_id: project.id, projectedCostUsd },
        guardClient,
      );
      recordCostSpy.mockImplementationOnce(async () => ({
        amount_usd: projectedCostUsd,
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

    // ========================================================================
    // STAGE 1 — classify (stubbed)
    // ========================================================================
    vi.mocked(classifyIntake).mockResolvedValueOnce({
      kind: 'software',
      confidence: 0.94,
      why: 'pages + entities + per-user data isolation = web app',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 90, output_tokens: 50 },
    });
    await gate(0.01, 'intake.classify');
    const classification = await classifyIntake({
      rawPrompt: spec.raw_prompt,
      governance: { user_id: USER_ID, project_id: project.id, ref: 'intake.classify' },
    });
    expect(classification.kind).toBe('software');

    // ========================================================================
    // STAGE 2 — extract SoftwareSpec (stubbed)
    // ========================================================================
    vi.mocked(extractSoftwareSpec).mockResolvedValueOnce({
      result: { spec: CANNED_SW_SPEC, open_questions: [] },
      usage: { input_tokens: 1200, output_tokens: 1500 },
      model: 'claude-sonnet-4-6',
      attempts: 1,
    });
    await gate(0.05, 'software.generate');
    const extracted = await extractSoftwareSpec({
      rawPrompt: spec.raw_prompt,
      governance: { user_id: USER_ID, project_id: project.id, ref: 'software.generate' },
    });
    expect(extracted.result.spec.pages).toHaveLength(3);

    await persistSoftwareExtractionResult({
      supabase,
      specId: spec.id,
      projectId: project.id,
      result: extracted.result,
      usage: extracted.usage,
      model: extracted.model,
      attempts: extracted.attempts,
      feedback: null,
      source: 'generate',
      classification,
    });

    // Both rows flip to kind='software'.
    {
      const persistedSpec = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(persistedSpec?.kind).toBe('software');
      expect(persistedSpec?.status).toBe('awaiting_review');
      const persistedProject = (db.tables.projects ?? []).find(
        (r) => r.id === project.id,
      ) as (Project & Record<string, unknown>) | undefined;
      expect(persistedProject?.kind).toBe('software');
    }

    // ========================================================================
    // GATE — software spec confirm
    // ========================================================================
    {
      const reloaded = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(reloaded).toBeTruthy();
      const confirmed = await confirmSoftwareSpec(supabase, reloaded as unknown as Spec);
      expect(confirmed.pages).toHaveLength(3);
      const after = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(after?.status).toBe('confirmed');
    }

    // ========================================================================
    // STOP — review-only boundary enforced server-side at BOTH planner loaders
    // ========================================================================
    const phase1Guard = await loadProjectWithConfirmedSpec(supabase, project.id);
    expect('error' in phase1Guard).toBe(true);
    if ('error' in phase1Guard) {
      expect(phase1Guard.status).toBe(409);
      expect(phase1Guard.error).toMatch(/review-only/i);
      expect(phase1Guard.error).toMatch(/software/i);
    }

    const phase2Guard = await loadProjectWithConfirmedSystemSpec(supabase, project.id);
    expect('error' in phase2Guard).toBe(true);
    if ('error' in phase2Guard) {
      expect(phase2Guard.status).toBe(409);
      expect(phase2Guard.error).toMatch(/SoftwareSpec/i);
    }

    // Governance coverage: classify + extract → 2 spy hits.
    expect(assertAllowedSpy).toHaveBeenCalledTimes(2);
    expect(recordCostSpy).toHaveBeenCalledTimes(2);
    for (const [input] of assertAllowedSpy.mock.calls) {
      expect(input.user_id).toBe(USER_ID);
      expect(input.project_id).toBe(PROJECT_ID);
      expect(input.projectedCostUsd).toBeGreaterThan(0);
    }
  });

  it('zero real fetch calls across the whole software dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
