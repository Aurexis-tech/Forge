// Hermetic end-to-end dry-run — Phase 4 INFRASTRUCTURE path.
//
// Mirrors tests/e2e/software-dryrun.test.ts. Drives a single project
// through:
//   1. classify (stubbed)        → kind='infrastructure'
//   2. extract  (stubbed)        → canned valid InfraSpec
//   3. confirmInfraSpec          → real gate, advances to confirmed
//   4. STOP                      → all three sibling planner loaders
//                                  (Phase 1 agent + Phase 2 system +
//                                  Phase 3 software) return 409
//                                  "review-only in this phase" for
//                                  kind='infrastructure'.
//
// NO real network. NO real DB. NO real spend.

import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  InfraSpecSchema,
  type InfraSpec,
} from '@/lib/engine/infra/spec';
import {
  confirmInfraSpec,
  persistInfraExtractionResult,
} from '@/lib/engine/infra/persistence';
import { loadProjectWithConfirmedSpec } from '@/lib/engine/planner/persistence';
import { loadProjectWithConfirmedSystemSpec } from '@/lib/engine/system/planner/persistence';
import { loadProjectWithConfirmedSoftwareSpec } from '@/lib/engine/software/planner/persistence';
import { assertAllowed } from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';
import {
  createInMemoryDb,
  makeClient,
} from '../helpers/in-memory-supabase';
import type { Project, Spec } from '@/lib/types';

// ---------------------------------------------------------------------------
// Mocks — same engine-function boundary as the agent + system + software
// dry-runs.
// ---------------------------------------------------------------------------

vi.mock('@/lib/engine/classify/classify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/classify/classify')>();
  return { ...actual, classifyIntake: vi.fn() };
});
vi.mock('@/lib/engine/infra/extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/infra/extract')>();
  return { ...actual, extractInfraSpec: vi.fn() };
});

import { classifyIntake } from '@/lib/engine/classify/classify';
import { extractInfraSpec } from '@/lib/engine/infra/extract';

const assertAllowedSpy = vi.fn<typeof assertAllowed>(assertAllowed);
const recordCostSpy = vi.fn<typeof recordCost>();

const USER_ID = 'user-infra-dry-run';
const PROJECT_ID = 'project-infra-dry-run';

const CANNED_INFRA_SPEC: InfraSpec = InfraSpecSchema.parse({
  goal: 'A pipeline that ingests events from sources hourly, stores them in Postgres, and serves them over HTTP.',
  resources: [
    { id: 'event_ingest_cron', type: 'cron', config: { schedule: 'every hour' } },
    {
      id: 'ingest_worker',
      type: 'worker',
      config: { runtime: 'node', concurrency: 2 },
    },
    {
      id: 'events_db',
      type: 'postgres_db',
      config: { schema_hint: 'events table with id, source, ts, payload' },
    },
    {
      id: 'events_api',
      type: 'http_service',
      config: { framework: 'nextjs', endpoints: ['/events', '/health'] },
    },
  ],
  topology: [
    { from: 'event_ingest_cron', to: 'ingest_worker' },
    { from: 'ingest_worker', to: 'events_db' },
    { from: 'events_api', to: 'events_db' },
  ],
  lifecycle: 'persistent',
});

function seedProject(db: ReturnType<typeof createInMemoryDb>): Project {
  const project: Project = {
    id: PROJECT_ID,
    user_id: USER_ID,
    name: 'Events Pipeline',
    status: 'draft',
    kind: 'agent', // starts default; classifier + persistence flip to 'infrastructure'
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
    id: 'spec-infra-1',
    project_id: project.id,
    raw_prompt:
      'a pipeline that ingests events from my sources every hour, stores them, and serves them to my other tools',
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

describe('Phase 4 INFRASTRUCTURE hermetic dry-run', () => {
  it('drives an infra project intake → confirmed-and-stopped, with all three sibling planner loaders enforcing 409', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof persistInfraExtractionResult
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
      kind: 'infrastructure',
      confidence: 0.92,
      why: 'resources + topology + no reasoning = infrastructure',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 90, output_tokens: 50 },
    });
    await gate(0.01, 'intake.classify');
    const classification = await classifyIntake({
      rawPrompt: spec.raw_prompt,
      governance: { user_id: USER_ID, project_id: project.id, ref: 'intake.classify' },
    });
    expect(classification.kind).toBe('infrastructure');

    // ========================================================================
    // STAGE 2 — extract InfraSpec (stubbed)
    // ========================================================================
    vi.mocked(extractInfraSpec).mockResolvedValueOnce({
      result: { spec: CANNED_INFRA_SPEC, open_questions: [] },
      usage: { input_tokens: 1200, output_tokens: 1500 },
      model: 'claude-sonnet-4-6',
      attempts: 1,
    });
    await gate(0.05, 'infra.generate');
    const extracted = await extractInfraSpec({
      rawPrompt: spec.raw_prompt,
      governance: { user_id: USER_ID, project_id: project.id, ref: 'infra.generate' },
    });
    expect(extracted.result.spec.resources).toHaveLength(4);
    expect(extracted.result.spec.topology).toHaveLength(3);

    await persistInfraExtractionResult({
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

    // Both rows flip to kind='infrastructure'.
    {
      const persistedSpec = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(persistedSpec?.kind).toBe('infrastructure');
      expect(persistedSpec?.status).toBe('awaiting_review');
      const persistedProject = (db.tables.projects ?? []).find(
        (r) => r.id === project.id,
      ) as (Project & Record<string, unknown>) | undefined;
      expect(persistedProject?.kind).toBe('infrastructure');
    }

    // ========================================================================
    // GATE — infrastructure spec confirm
    // ========================================================================
    {
      const reloaded = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(reloaded).toBeTruthy();
      const confirmed = await confirmInfraSpec(supabase, reloaded as unknown as Spec);
      expect(confirmed.resources).toHaveLength(4);
      expect(confirmed.lifecycle).toBe('persistent');
      const after = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(after?.status).toBe('confirmed');
    }

    // ========================================================================
    // STOP — review-only boundary enforced server-side at ALL THREE sibling
    // planner loaders. A confirmed infrastructure spec cannot reach any
    // generation path.
    // ========================================================================
    const phase1Guard = await loadProjectWithConfirmedSpec(supabase, project.id);
    expect('error' in phase1Guard).toBe(true);
    if ('error' in phase1Guard) {
      expect(phase1Guard.status).toBe(409);
      expect(phase1Guard.error).toMatch(/review-only/i);
      expect(phase1Guard.error).toMatch(/infrastructure|InfraSpec/i);
    }

    const phase2Guard = await loadProjectWithConfirmedSystemSpec(supabase, project.id);
    expect('error' in phase2Guard).toBe(true);
    if ('error' in phase2Guard) {
      expect(phase2Guard.status).toBe(409);
      expect(phase2Guard.error).toMatch(/review-only/i);
      expect(phase2Guard.error).toMatch(/infrastructure|InfraSpec/i);
    }

    const phase3Guard = await loadProjectWithConfirmedSoftwareSpec(supabase, project.id);
    expect('error' in phase3Guard).toBe(true);
    if ('error' in phase3Guard) {
      expect(phase3Guard.status).toBe(409);
      expect(phase3Guard.error).toMatch(/review-only/i);
      expect(phase3Guard.error).toMatch(/infrastructure|InfraSpec/i);
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

  it('zero real fetch calls across the whole infrastructure dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
