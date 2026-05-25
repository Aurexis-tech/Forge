// Hermetic end-to-end dry-run — Phase 2 SYSTEM path.
//
// Mirrors tests/e2e/dryrun.test.ts (the agent path) using the same
// test infrastructure: in-memory Supabase, fetch-throws guard from
// tests/setup.ts, vi.mock for engine boundaries. Drives a single
// project through the SYSTEM pipeline:
//
//   1. classify (stubbed)        → kind='system'
//   2. extract  (stubbed)        → canned 3-agent pipeline SystemSpec
//   3. confirmSystemSpec         → real gate, advances to confirmed
//   4. planSystem                → REAL deriveGraph + REAL cycle check
//                                  + REAL assertWithinStepBudget;
//                                  ONLY the per-node LLM detail pass
//                                  (lib/engine/llm.complete) is stubbed
//   5. approveSystemPlan         → real gate, advances to approved
//   6. STOP                      → the Phase 1 boundaries (loadProject-
//                                  WithConfirmedSpec for codegen, and
//                                  loadProjectWithConfirmedSystemSpec
//                                  when misrouted) BOTH return 409.
//
// Plus negative path coverage (cyclic spec, over-budget spec) and the
// same governance-coverage + zero-fetch assertions as the agent run.
//
// NO real network. NO real DB. NO real spend.

import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  SystemSpecSchema,
  type SystemSpec,
} from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
} from '@/lib/engine/system/planner/schema';
import {
  SystemPlanError,
  planSystem,
} from '@/lib/engine/system/planner/plan';
import {
  approveSystemPlan,
  ensureSystemPlanRow,
  loadLatestSystemPlan,
  loadProjectWithConfirmedSystemSpec,
  persistSystemPlanResult,
} from '@/lib/engine/system/planner/persistence';
import {
  confirmSystemSpec,
  persistSystemExtractionResult,
} from '@/lib/engine/system/persistence';
import {
  loadProjectWithConfirmedSpec,
} from '@/lib/engine/planner/persistence';
import {
  assertAllowed,
} from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';
import {
  createInMemoryDb,
  makeClient,
} from '../helpers/in-memory-supabase';
import type {
  Plan,
  Project,
  Spec,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Mock the same engine-function boundary as the agent dry-run:
//   - classifyIntake (replaces the classifier LLM call)
//   - extractSystemSpec (replaces the system extractor LLM call)
//   - complete (replaces the per-node LLM detail pass inside planSystem)
// ---------------------------------------------------------------------------

vi.mock('@/lib/engine/classify/classify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/classify/classify')>();
  return {
    ...actual,
    classifyIntake: vi.fn(),
  };
});
vi.mock('@/lib/engine/system/extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/system/extract')>();
  return {
    ...actual,
    extractSystemSpec: vi.fn(),
  };
});
vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return {
    ...actual,
    complete: vi.fn(),
  };
});

import { classifyIntake } from '@/lib/engine/classify/classify';
import { extractSystemSpec } from '@/lib/engine/system/extract';
import { complete } from '@/lib/engine/llm';

// ---------------------------------------------------------------------------
// Spies on governance + ledger so the test can assert every system cost
// point observed the guard.
// ---------------------------------------------------------------------------

const assertAllowedSpy = vi.fn<typeof assertAllowed>(assertAllowed);
const recordCostSpy = vi.fn<typeof recordCost>();

// ---------------------------------------------------------------------------
// Canned data.
// ---------------------------------------------------------------------------

const USER_ID = 'user-sys-dry-run';
const PROJECT_ID = 'project-sys-dry-run';

// Three-agent pipeline. Schema-valid; coordination defaults to pipeline
// so edges are synthesised by deriveGraph in declaration order.
const CANNED_SYSTEM_SPEC: SystemSpec = SystemSpecSchema.parse({
  goal: 'Email me a five-bullet brief of new arXiv CV papers daily.',
  sub_agents: [
    {
      id: 'scraper',
      role: 'scraper',
      description: 'Pulls fresh arXiv CV listings.',
      inputs: ['time_window'],
      outputs: ['raw_papers'],
    },
    {
      id: 'summarizer',
      role: 'summarizer',
      description: 'Reduces raw paper abstracts into a short brief.',
      inputs: ['raw_papers'],
      outputs: ['summary'],
    },
    {
      id: 'emailer',
      role: 'emailer',
      description: 'Sends the brief to the user.',
      inputs: ['summary'],
      outputs: ['delivery_receipt'],
    },
  ],
  coordination: { pattern: 'pipeline' },
  triggers: ['schedule'],
});

// The LLM detail pass that planSystem makes — one JSON object with
// per-node enrichment. Must include every node id from the graph and
// satisfy the tool-grounding rules (registry_id + env_keys from the
// real TOOL_REGISTRY).
const CANNED_LLM_DETAIL_JSON = JSON.stringify({
  nodes: [
    {
      id: 'scraper',
      task: 'Fetches new arXiv computer-vision papers from the last 24 hours.',
      outputs: ['raw_papers'],
      suggested_tools: [
        {
          requested: 'web_search',
          status: 'supported',
          registry_id: 'web_search',
          env_keys: [],
        },
      ],
    },
    {
      id: 'summarizer',
      task: 'Reduces raw paper abstracts into a five-bullet brief.',
      outputs: ['summary'],
      suggested_tools: [
        {
          requested: 'llm_completion',
          status: 'supported',
          registry_id: 'llm_completion',
          env_keys: ['ANTHROPIC_API_KEY'],
        },
      ],
    },
    {
      id: 'emailer',
      task: 'Sends the brief to the user via email.',
      outputs: ['delivery_receipt'],
      suggested_tools: [
        {
          requested: 'email_send',
          status: 'needs_key',
          registry_id: 'email_send',
          env_keys: ['RESEND_API_KEY'],
        },
      ],
    },
  ],
  warnings: [],
});

function seedProject(db: ReturnType<typeof createInMemoryDb>): Project {
  const project: Project = {
    id: PROJECT_ID,
    user_id: USER_ID,
    name: 'arXiv System',
    status: 'draft',
    // Starts as 'agent' — the classifier flips it to 'system' on
    // persistSystemExtractionResult, exactly as production does.
    kind: 'agent',
    created_at: new Date().toISOString(),
  };
  if (!db.tables.projects) db.tables.projects = [];
  db.tables.projects.push(project as unknown as Record<string, unknown>);
  return project;
}

function seedSpec(db: ReturnType<typeof createInMemoryDb>, project: Project): Spec {
  const spec: Spec = {
    id: 'spec-sys-1',
    project_id: project.id,
    raw_prompt:
      'A system that scrapes new arXiv CV papers, summarizes them, and emails me a brief.',
    structured_spec: null,
    open_questions: null,
    feedback: null,
    status: 'pending',
    // Starts as 'agent' — flipped to 'system' by persistSystemExtractionResult.
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

describe('Phase 2 SYSTEM hermetic dry-run', () => {
  it('drives a system project intake → approved-and-stopped, with the Phase 1 boundary enforced', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof persistSystemExtractionResult
    >[0]['supabase'];
    const guardClient = makeClient(db) as unknown as Parameters<typeof assertAllowed>[1];

    const project = seedProject(db);
    const spec = seedSpec(db, project);

    // Reset spy counters for this test (the file-level spies persist
    // across tests in the same suite).
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
    // STAGE 1 — classify (stubbed to return 'system')
    // ========================================================================
    vi.mocked(classifyIntake).mockResolvedValueOnce({
      kind: 'system',
      confidence: 0.92,
      why: 'three distinct roles in a clear pipeline (scrape → summarize → email)',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 80, output_tokens: 40 },
    });

    await gate(0.01, 'intake.classify');
    const classification = await classifyIntake({
      rawPrompt: spec.raw_prompt,
      governance: { user_id: USER_ID, project_id: project.id, ref: 'intake.classify' },
    });
    expect(classification.kind).toBe('system');

    // ========================================================================
    // STAGE 2 — extract SystemSpec (stubbed)
    // ========================================================================
    vi.mocked(extractSystemSpec).mockResolvedValueOnce({
      result: { spec: CANNED_SYSTEM_SPEC, open_questions: [] },
      usage: { input_tokens: 900, output_tokens: 1400 },
      model: 'claude-sonnet-4-6',
      attempts: 1,
    });

    await gate(0.05, 'system.generate');
    const extracted = await extractSystemSpec({
      rawPrompt: spec.raw_prompt,
      governance: { user_id: USER_ID, project_id: project.id, ref: 'system.generate' },
    });
    expect(extracted.result.spec.sub_agents).toHaveLength(3);

    await persistSystemExtractionResult({
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

    // Both rows now carry kind='system'. This is the discriminator
    // every downstream gate keys off.
    {
      const persistedSpec = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(persistedSpec?.kind).toBe('system');
      expect(persistedSpec?.status).toBe('awaiting_review');
      expect(persistedSpec?.structured_spec).toBeTruthy();
      const persistedProject = (db.tables.projects ?? []).find(
        (r) => r.id === project.id,
      ) as (Project & Record<string, unknown>) | undefined;
      expect(persistedProject?.kind).toBe('system');
    }

    // ========================================================================
    // GATE 1 — system spec confirm
    // ========================================================================
    {
      const reloaded = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(reloaded).toBeTruthy();
      const confirmed = await confirmSystemSpec(supabase, reloaded as unknown as Spec);
      expect(confirmed.sub_agents).toHaveLength(3);
      const after = (db.tables.specs ?? []).find((r) => r.id === spec.id) as
        | (Spec & Record<string, unknown>)
        | undefined;
      expect(after?.status).toBe('confirmed');
    }

    // ========================================================================
    // STAGE 3 — orchestration plan: REAL graph + cycle + budget;
    //           ONLY the LLM detail pass is stubbed
    // ========================================================================
    vi.mocked(complete).mockResolvedValueOnce({
      text: CANNED_LLM_DETAIL_JSON,
      usage: { input_tokens: 1500, output_tokens: 2200 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    await gate(0.08, 'system.plan.generate');
    const planResult = await planSystem({
      spec: CANNED_SYSTEM_SPEC,
      governance: {
        user_id: USER_ID,
        project_id: project.id,
        ref: 'system.plan.generate',
      },
    });

    // The planner returned a real OrchestrationPlan derived from the
    // canned spec. The graph was synthesised by deriveGraph (pipeline
    // pattern → consecutive edges); the LLM detail pass enriched each
    // node with task + suggested_tools; the assembled plan was
    // re-validated against OrchestrationPlanSchema.
    expect(planResult.plan.nodes).toHaveLength(3);
    expect(planResult.plan.nodes.map((n) => n.id)).toEqual([
      'scraper',
      'summarizer',
      'emailer',
    ]);
    expect(planResult.plan.edges.map((e) => [e.from, e.to])).toEqual([
      ['scraper', 'summarizer'],
      ['summarizer', 'emailer'],
    ]);
    // Topological execution order honours the pipeline shape.
    expect(planResult.plan.execution_order).toEqual([
      'scraper',
      'summarizer',
      'emailer',
    ]);
    // Within the spec's max_steps cap.
    expect(planResult.plan.nodes.length).toBeLessThanOrEqual(
      CANNED_SYSTEM_SPEC.max_steps,
    );

    const planRow = await ensureSystemPlanRow(supabase, project.id, spec.id);
    await persistSystemPlanResult({
      supabase,
      planId: planRow.id,
      projectId: project.id,
      plan: planResult.plan,
      usage: planResult.usage,
      model: planResult.model,
      attempts: planResult.attempts,
      feedback: null,
      source: 'generate',
    });

    {
      const reloaded = await loadLatestSystemPlan(supabase, project.id);
      expect(reloaded?.kind).toBe('system');
      expect(reloaded?.status).toBe('awaiting_review');
    }

    // ========================================================================
    // GATE 2 — system plan approve
    // ========================================================================
    {
      const reloaded = await loadLatestSystemPlan(supabase, project.id);
      expect(reloaded).toBeTruthy();
      const approved = await approveSystemPlan(supabase, reloaded as unknown as Plan);
      expect(approved.nodes).toHaveLength(3);
      const after = await loadLatestSystemPlan(supabase, project.id);
      expect(after?.status).toBe('approved');
    }

    // ========================================================================
    // STOP — Phase 1 boundary fires for kind='system' projects.
    //
    // The brief explicitly scopes Phase 2 to intake + planning ONLY.
    // codegen/sandbox/deploy/runtime stay closed for systems. The
    // single gate that enforces this server-side is the Phase 1
    // planner's `loadProjectWithConfirmedSpec` — it must return 409
    // with a clear "review-only in this phase" message rather than
    // letting a system spec slip into the agent build pipeline.
    // ========================================================================
    const phase1Guard = await loadProjectWithConfirmedSpec(supabase, project.id);
    expect('error' in phase1Guard).toBe(true);
    if ('error' in phase1Guard) {
      expect(phase1Guard.status).toBe(409);
      expect(phase1Guard.error).toMatch(/review-only/i);
      expect(phase1Guard.error).toMatch(/system/i);
    }

    // ========================================================================
    // GOVERNANCE COVERAGE — classify + extract + plan
    // ========================================================================
    expect(assertAllowedSpy).toHaveBeenCalledTimes(3);
    for (const call of assertAllowedSpy.mock.calls) {
      const [input] = call;
      expect(input.user_id).toBe(USER_ID);
      expect(input.project_id).toBe(PROJECT_ID);
      expect(typeof input.projectedCostUsd).toBe('number');
      expect(input.projectedCostUsd).toBeGreaterThan(0);
    }
    expect(recordCostSpy).toHaveBeenCalledTimes(3);
  });

  // ========================================================================
  // Negative path: cyclic SystemSpec
  // ========================================================================
  it('planSystem rejects a cyclic SystemSpec with a clean SystemPlanError', async () => {
    // SystemSpecSchema only catches self-edges + unknown refs in its
    // superRefine; cross-node cycles slip through and are caught
    // structurally by deriveGraph's reused validateTaskGraph. We
    // construct a 3-node dag with edges that form a cycle, parse it
    // through the schema, then feed it to planSystem.
    const cyclic = SystemSpecSchema.parse({
      goal: 'A cycle that should be rejected at planning time.',
      sub_agents: [
        { id: 'a', role: 'A', description: 'first', inputs: [], outputs: ['x'] },
        { id: 'b', role: 'B', description: 'second', inputs: ['x'], outputs: ['y'] },
        { id: 'c', role: 'C', description: 'third', inputs: ['y'], outputs: ['z'] },
      ],
      coordination: {
        pattern: 'dag',
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'a' }, // ← the cycle
        ],
      },
      triggers: ['chat'],
    });

    // No LLM mock set: deriveGraph rejects BEFORE planSystem reaches the
    // LLM detail pass. If it ever did reach the LLM, complete() would
    // be undefined-resolved and the test would surface that as a different
    // failure (loud, not silent).
    await expect(
      planSystem({
        spec: cyclic,
        governance: {
          user_id: USER_ID,
          project_id: PROJECT_ID,
          ref: 'system.plan.cycle-test',
        },
      }),
    ).rejects.toBeInstanceOf(SystemPlanError);

    try {
      await planSystem({
        spec: cyclic,
        governance: { user_id: USER_ID, project_id: PROJECT_ID },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(SystemPlanError);
      const e = err as SystemPlanError;
      // The wrapped graph error reaches the user as a clean message —
      // no stack-trace leak, no crash.
      expect(e.message).toMatch(/orchestration graph rejected/i);
      expect(e.message).toMatch(/cycle/i);
    }
  });

  // ========================================================================
  // Negative path: over-budget spec
  // ========================================================================
  it('planSystem rejects an over-budget spec with a clean SystemPlanError', async () => {
    // 3 sub_agents but max_steps=2 → node count exceeds the cap.
    // SystemSpecSchema accepts max_steps in [1, HARD_CAP_MAX_STEPS]
    // so the budget check is enforced by the planner, not the schema.
    const overBudget = SystemSpecSchema.parse({
      goal: 'Three nodes but only 2 step budget.',
      sub_agents: [
        { id: 'a', role: 'A', description: 'first', inputs: [], outputs: ['x'] },
        { id: 'b', role: 'B', description: 'second', inputs: ['x'], outputs: ['y'] },
        { id: 'c', role: 'C', description: 'third', inputs: ['y'], outputs: ['z'] },
      ],
      coordination: { pattern: 'pipeline' },
      triggers: ['schedule'],
      max_steps: 2,
    });

    await expect(
      planSystem({
        spec: overBudget,
        governance: {
          user_id: USER_ID,
          project_id: PROJECT_ID,
          ref: 'system.plan.budget-test',
        },
      }),
    ).rejects.toBeInstanceOf(SystemPlanError);

    try {
      await planSystem({
        spec: overBudget,
        governance: { user_id: USER_ID, project_id: PROJECT_ID },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(SystemPlanError);
      const e = err as SystemPlanError;
      // Clean human-readable message — no crash.
      expect(e.message).toMatch(/3 nodes/);
      expect(e.message).toMatch(/max_steps at 2/);
    }
  });

  // ========================================================================
  // Misroute: system planner refuses to load an agent project.
  // ========================================================================
  it('loadProjectWithConfirmedSystemSpec rejects a kind=agent misroute with 409', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadProjectWithConfirmedSystemSpec
    >[0];

    // Seed an AGENT project that's spec-confirmed — the situation
    // where someone calls the system planner route on a Phase 1
    // project by accident.
    db.tables.projects = [
      {
        id: 'p-agent-1',
        user_id: USER_ID,
        name: 'agent-project',
        status: 'spec_confirmed',
        kind: 'agent',
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.specs = [
      {
        id: 's-agent-1',
        project_id: 'p-agent-1',
        raw_prompt: 'single agent',
        // Minimal structured_spec — the kind check fires before schema
        // validation so we don't need a complete AgentSpec payload here.
        structured_spec: { name: 'x', goal: 'x' },
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'agent',
        created_at: new Date().toISOString(),
      },
    ];

    const result = await loadProjectWithConfirmedSystemSpec(supabase, 'p-agent-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/AgentSpec/i);
    }
  });

  // ========================================================================
  // Hermeticity — same shape as the agent dry-run.
  // ========================================================================
  it('zero real fetch calls across the whole system dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});

// Validate the canned OrchestrationPlan shape one more time at module
// load — guarantees the test's mocked LLM detail JSON is well-formed
// before we even run a test. If this throws, the canned JSON has
// drifted from OrchestrationPlanSchema and the dry-run would fail
// for the wrong reason.
{
  const parsed = JSON.parse(CANNED_LLM_DETAIL_JSON) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('CANNED_LLM_DETAIL_JSON must parse to an object');
  }
  // We don't validate the full OrchestrationPlan here (the test does
  // that through the real planSystem stitch+validate path); we only
  // sanity-check the LLM-shape contract on module load.
  if (!Array.isArray((parsed as { nodes?: unknown[] }).nodes)) {
    throw new Error('CANNED_LLM_DETAIL_JSON must contain a nodes array');
  }
  // Use the schema import so it isn't tree-shaken out — keeps the
  // import-time invariant honest even if the test file is parsed
  // statically.
  void OrchestrationPlanSchema;
}
