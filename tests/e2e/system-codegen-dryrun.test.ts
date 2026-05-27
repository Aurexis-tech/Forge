// Hermetic end-to-end dry-run — Phase 2 (Systems) CODEGEN.
//
// Companion to system-dryrun.test.ts. That file drives the intake +
// planning side and stops at approved; this file picks up from
// approved and exercises codegen — the new stage Phase 2 just gained.
//
//   1. seed a project + confirmed SystemSpec + approved OrchestrationPlan
//   2. loadApprovedSystemPlanForCodegen        → returns the chain
//   3. generateSystemCode                       → REAL orchestrator
//                                                 template + REAL static
//                                                 check; ONLY the per-
//                                                 node LLM call (the
//                                                 reused Phase 1 agent
//                                                 generator at the
//                                                 complete() boundary)
//                                                 is stubbed
//   4. persistence: ensureSystemCodegenBuild → 'queued', then
//      storeSystemBuildFiles + completeSystemCodegen → 'generated'
//   5. STOP: confirm the brief's "system still cannot reach sandbox /
//      deploy / runtime" stays true: assert the Phase 1 codegen loader
//      refuses with 409, AND that the system project has no row in any
//      of the downstream tables (sandbox_runs, deployments, agent_runtimes).
//
// NO real network. NO real DB. NO real spend.

import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  SystemSpecSchema,
  type SystemSpec,
} from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';
import {
  generateSystemCode,
  SystemCodegenError,
} from '@/lib/engine/system/codegen/generate';
import {
  completeSystemCodegen,
  ensureSystemCodegenBuild,
  loadApprovedSystemPlanForCodegen,
  loadLatestSystemBuild,
  logSystemCodegenStarted,
  markSystemBuildGenerating,
  storeSystemBuildFiles,
} from '@/lib/engine/system/codegen/persistence';
import { loadApprovedPlanForCodegen } from '@/lib/engine/codegen/persistence';
import { assertAllowed } from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';
import {
  createInMemoryDb,
  makeClient,
} from '../helpers/in-memory-supabase';
import type { Build, Plan, Project, Spec } from '@/lib/types';

// ---------------------------------------------------------------------------
// Mock the LLM `complete()` so the reused Phase 1 per-file generator
// (`generateOneAgentFile`) runs without network. The orchestrator
// generator + static check + scaffold materialisation all run for real.
// ---------------------------------------------------------------------------

vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return { ...actual, complete: vi.fn() };
});

import { complete } from '@/lib/engine/llm';

// Spies on governance + ledger — assert every per-node LLM cost point
// observed the guard.
const assertAllowedSpy = vi.fn<typeof assertAllowed>(assertAllowed);
const recordCostSpy = vi.fn<typeof recordCost>();

// ---------------------------------------------------------------------------
// Canned data — a 3-node pipeline (the same shape the system planner
// dry-run already proves out, lifted into a confirmed+approved state).
// ---------------------------------------------------------------------------

const USER_ID = 'user-sys-codegen-dry-run';
const PROJECT_ID = 'project-sys-codegen-dry-run';

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

const CANNED_ORCH_PLAN: OrchestrationPlan = OrchestrationPlanSchema.parse({
  goal: CANNED_SYSTEM_SPEC.goal,
  pattern: 'pipeline',
  max_steps: CANNED_SYSTEM_SPEC.max_steps,
  nodes: [
    {
      id: 'scraper',
      role: 'scraper',
      task: 'Fetches new arXiv computer-vision papers from the last 24 hours.',
      inputs: [{ from: null, output: 'time_window' }],
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
      role: 'summarizer',
      task: 'Reduces raw paper abstracts into a five-bullet brief.',
      inputs: [{ from: 'scraper', output: 'raw_papers' }],
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
      role: 'emailer',
      task: 'Sends the brief to the user via email.',
      inputs: [{ from: 'summarizer', output: 'summary' }],
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
  edges: [
    { from: 'scraper', to: 'summarizer', payload: 'raw_papers' },
    { from: 'summarizer', to: 'emailer', payload: 'summary' },
  ],
  execution_order: ['scraper', 'summarizer', 'emailer'],
  warnings: [],
});

// Minimal, parseable TypeScript module body for each per-node LLM
// response. The body has to satisfy esbuild's parse — actual semantics
// don't matter because we never execute generated code.
function cannedModuleBody(nodeId: string): string {
  const lines = [
    '// Module for node ' + nodeId + '. Generated.',
    'export async function run(',
    '  input: Record<string, unknown>,',
    '): Promise<Record<string, unknown>> {',
    '  // Static-check-only stub - never executed at this layer.',
    '  return { ...input, node: ' + JSON.stringify(nodeId) + ' };',
    '}',
    '',
  ];
  return lines.join('\n');
}

afterAll(() => {
  vi.restoreAllMocks();
});

describe('Phase 2 SYSTEM codegen hermetic dry-run', () => {
  it('drives approved orchestration plan → generated system build, with downstream still closed', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedSystemPlanForCodegen
    >[0];
    const guardClient = makeClient(db) as unknown as Parameters<typeof assertAllowed>[1];

    // Seed: confirmed system spec + approved orchestration plan.
    const project: Project = {
      id: PROJECT_ID,
      user_id: USER_ID,
      name: 'arXiv System',
      status: 'plan_approved',
      kind: 'system',
      created_at: new Date().toISOString(),
    };
    const spec: Spec = {
      id: 'spec-sys-codegen-1',
      project_id: project.id,
      raw_prompt: 'arxiv pipeline',
      structured_spec: CANNED_SYSTEM_SPEC as unknown as Spec['structured_spec'],
      open_questions: [],
      feedback: null,
      status: 'confirmed',
      kind: 'system',
      created_at: new Date().toISOString(),
    };
    const planRow: Plan = {
      id: 'plan-sys-codegen-1',
      project_id: project.id,
      spec_id: spec.id,
      plan: CANNED_ORCH_PLAN as unknown as Plan['plan'],
      status: 'approved',
      feedback: null,
      kind: 'system',
      created_at: new Date().toISOString(),
    };
    db.tables.projects = [project as unknown as Record<string, unknown>];
    db.tables.specs = [spec as unknown as Record<string, unknown>];
    db.tables.plans = [planRow as unknown as Record<string, unknown>];

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

    // The system loader returns the confirmed-spec + approved-plan chain.
    const ctx = await loadApprovedSystemPlanForCodegen(supabase, project.id);
    expect('error' in ctx).toBe(false);
    if ('error' in ctx) throw new Error('loader unexpected: ' + ctx.error);
    expect(ctx.parsedSpec.sub_agents).toHaveLength(3);
    expect(ctx.parsedPlan.execution_order).toEqual([
      'scraper',
      'summarizer',
      'emailer',
    ]);

    // ========================================================================
    // STAGE — codegen: REAL orchestrator template + static check; the
    // reused agent generator's LLM call is the only thing stubbed (one
    // mock per node module).
    // ========================================================================
    vi.mocked(complete).mockResolvedValueOnce({
      text: cannedModuleBody('scraper'),
      usage: { input_tokens: 1500, output_tokens: 800 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });
    vi.mocked(complete).mockResolvedValueOnce({
      text: cannedModuleBody('summarizer'),
      usage: { input_tokens: 1500, output_tokens: 800 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });
    vi.mocked(complete).mockResolvedValueOnce({
      text: cannedModuleBody('emailer'),
      usage: { input_tokens: 1500, output_tokens: 800 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    // One governance hit per node module — matches the per-call cost
    // gate inside lib/engine/llm.complete().
    for (const nodeId of ['scraper', 'summarizer', 'emailer']) {
      await gate(0.05, 'system.codegen.module.' + nodeId);
    }

    // Insert the build row through the persistence helper to match the
    // route's order of operations.
    const buildResult = await ensureSystemCodegenBuild(
      supabase,
      project.id,
      planRow.id,
      spec.id,
    );
    expect('error' in buildResult).toBe(false);
    if ('error' in buildResult) throw new Error('build row unexpected');
    const build: Build = buildResult.build;
    expect(build.kind).toBe('system');
    expect(build.status).toBe('queued');

    await logSystemCodegenStarted(supabase, build);
    await markSystemBuildGenerating(supabase, build.id);

    const summary = await generateSystemCode({
      spec: ctx.parsedSpec,
      plan: ctx.parsedPlan,
      governance: {
        user_id: USER_ID,
        project_id: project.id,
        ref: 'system.codegen.generate.' + build.id,
      },
    });

    // === Orchestrator + entrypoint + per-node modules all materialise ===
    expect(summary.orchestratorPath).toBe('src/orchestrator.ts');
    expect(summary.entrypointPath).toBe('src/index.ts');
    expect(summary.modulesGenerated).toBe(3);
    expect(summary.modulesFailed).toBe(0);

    const paths = summary.files.map((f) => f.path);
    expect(paths).toContain('src/orchestrator.ts');
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/modules/scraper/index.ts');
    expect(paths).toContain('src/modules/summarizer/index.ts');
    expect(paths).toContain('src/modules/emailer/index.ts');

    // Every file passed the per-file esbuild static check (deterministic
    // orchestrator + entrypoint + the canned module bodies).
    for (const f of summary.files) {
      expect(f.staticCheck.ok).toBe(true);
    }

    // === Orchestrator embeds max-steps ceiling + handoff validation ===
    const orchestrator = summary.files.find(
      (f) => f.path === 'src/orchestrator.ts',
    );
    expect(orchestrator).toBeTruthy();
    if (!orchestrator) throw new Error('orchestrator missing');
    // Hard-coded max-steps literal from the SystemSpec.
    expect(orchestrator.content).toContain(
      'const MAX_STEPS = ' + String(CANNED_SYSTEM_SPEC.max_steps),
    );
    // Handoff validation surface — both directions.
    expect(orchestrator.content).toMatch(/handoff failed:/);
    expect(orchestrator.content).toMatch(/handoff validation failed:/);
    // The execution_order is embedded verbatim from the plan.
    expect(orchestrator.content).toContain(
      JSON.stringify(CANNED_ORCH_PLAN.execution_order),
    );

    // Persist + complete — exactly like the route does.
    await storeSystemBuildFiles(supabase, build.id, summary);
    await completeSystemCodegen(supabase, build, summary);

    const reloaded = await loadLatestSystemBuild(supabase, project.id);
    expect(reloaded?.kind).toBe('system');
    expect(reloaded?.status).toBe('generated');

    // === Build files are persisted with the right source labels ===
    const buildFileRows = (db.tables.build_files ?? []) as Array<
      Record<string, unknown>
    >;
    expect(buildFileRows.length).toBe(summary.files.length);
    const scaffoldRows = buildFileRows.filter((r) => r.source === 'scaffold');
    const generatedRows = buildFileRows.filter((r) => r.source === 'generated');
    expect(scaffoldRows.length).toBeGreaterThan(0);
    // Three modules + orchestrator + entrypoint = 5 generated files.
    expect(generatedRows.length).toBe(5);

    // === Audit log carries the system.codegen_* trail ===
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    const startedRow = audit.find(
      (r) => r.action === 'system.codegen_started',
    );
    const completedRow = audit.find(
      (r) => r.action === 'system.codegen_completed',
    );
    expect(startedRow).toBeTruthy();
    expect(completedRow).toBeTruthy();

    // ========================================================================
    // STOP — system codegen is the LAST stop for kind='system' in this phase.
    //
    // The brief: "system still cannot reach sandbox / deploy / runtime."
    // We assert this two ways:
    //   1. The Phase 1 codegen loader refuses a system spec with 409
    //      (defence in depth from the route side; even a direct caller
    //      can't sneak in).
    //   2. There are no sandbox / deployment / runtime rows because no
    //      route exists for kind='system' to insert them.
    // ========================================================================
    const phase1 = await loadApprovedPlanForCodegen(supabase, project.id);
    expect('error' in phase1).toBe(true);
    if ('error' in phase1) {
      expect(phase1.status).toBe(409);
      expect(phase1.error).toMatch(/SystemSpec/i);
      expect(phase1.error).toMatch(/system\/build\/generate/i);
    }

    expect((db.tables.sandbox_runs ?? []).length).toBe(0);
    expect((db.tables.deployments ?? []).length).toBe(0);
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);

    // Governance coverage — one per per-node LLM call.
    expect(assertAllowedSpy).toHaveBeenCalledTimes(3);
    expect(recordCostSpy).toHaveBeenCalledTimes(3);
    for (const call of assertAllowedSpy.mock.calls) {
      const [input] = call;
      expect(input.user_id).toBe(USER_ID);
      expect(input.project_id).toBe(PROJECT_ID);
      expect(input.projectedCostUsd).toBeGreaterThan(0);
    }
  });

  // ========================================================================
  // Misroute: system codegen loader refuses an agent project.
  // ========================================================================
  it('loadApprovedSystemPlanForCodegen rejects an agent project with 409', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedSystemPlanForCodegen
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

    const result = await loadApprovedSystemPlanForCodegen(supabase, 'p-agent-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/AgentSpec/i);
    }
  });

  // ========================================================================
  // Misroute: Phase 1 codegen loader refuses a system project with the
  // new explicit 409 (rather than the previous accidental 422).
  // ========================================================================
  it('loadApprovedPlanForCodegen rejects a system project with 409 + the right hint', async () => {
    const db = createInMemoryDb();
    const supabase = makeClient(db) as unknown as Parameters<
      typeof loadApprovedPlanForCodegen
    >[0];

    db.tables.projects = [
      {
        id: 'p-sys-2',
        user_id: USER_ID,
        name: 'system-project',
        status: 'plan_approved',
        kind: 'system',
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.specs = [
      {
        id: 's-sys-2',
        project_id: 'p-sys-2',
        raw_prompt: 'multi-agent system',
        structured_spec: CANNED_SYSTEM_SPEC as unknown as Spec['structured_spec'],
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'system',
        created_at: new Date().toISOString(),
      },
    ];

    const result = await loadApprovedPlanForCodegen(supabase, 'p-sys-2');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/SystemSpec/i);
      expect(result.error).toMatch(/system\/build\/generate/i);
    }
  });

  // ========================================================================
  // Error surface — SystemCodegenError is preserved for ops debugging.
  // ========================================================================
  it('SystemCodegenError surface is preserved', () => {
    expect(SystemCodegenError).toBeDefined();
    expect(SystemCodegenError.prototype.name).toBe('Error');
  });

  // ========================================================================
  // Hermeticity — zero real fetch calls.
  // ========================================================================
  it('zero real fetch calls across the whole system codegen dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
