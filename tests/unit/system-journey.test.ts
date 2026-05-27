// Unit test: deriveJourney(kind='system') maps every system status to
// the right stage cursor — and the agent journey output is bit-
// identical to before. Phase 1 presentation untouched is a hard
// invariant; the agent baseline assertions cover that explicitly.

import { describe, expect, it } from 'vitest';
import { deriveJourney } from '@/lib/journey';
import type {
  AgentRuntime,
  Build,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import {
  SystemSpecSchema,
  type SystemSpec,
} from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';

// ---------------------------------------------------------------------------
// Fixtures — a canned system spec + plan + bare project/build/runtime
// row builders. Everything is kind='system' so the journey dispatch
// takes the new path; mutating one field at a time exercises the per-
// status branches.
// ---------------------------------------------------------------------------

const SYSTEM_SPEC: SystemSpec = SystemSpecSchema.parse({
  goal: 'arxiv pipeline',
  sub_agents: [
    {
      id: 'scraper',
      role: 'scraper',
      description: 'x',
      inputs: ['time_window'],
      outputs: ['raw_papers'],
    },
    {
      id: 'summarizer',
      role: 'summarizer',
      description: 'x',
      inputs: ['raw_papers'],
      outputs: ['summary'],
    },
    {
      id: 'emailer',
      role: 'emailer',
      description: 'x',
      inputs: ['summary'],
      outputs: ['delivery_receipt'],
    },
  ],
  coordination: { pattern: 'pipeline' },
  // Schedule trigger so isRuntimeMode flips true; the system path
  // shouldn't skip deploy regardless.
  triggers: ['schedule'],
});

const ORCH_PLAN: OrchestrationPlan = OrchestrationPlanSchema.parse({
  goal: 'arxiv pipeline',
  pattern: 'pipeline',
  max_steps: SYSTEM_SPEC.max_steps,
  nodes: [
    {
      id: 'scraper',
      role: 'scraper',
      task: 'x',
      inputs: [{ from: null, output: 'time_window' }],
      outputs: ['raw_papers'],
      suggested_tools: [],
    },
    {
      id: 'summarizer',
      role: 'summarizer',
      task: 'x',
      inputs: [{ from: 'scraper', output: 'raw_papers' }],
      outputs: ['summary'],
      suggested_tools: [],
    },
    {
      id: 'emailer',
      role: 'emailer',
      task: 'x',
      inputs: [{ from: 'summarizer', output: 'summary' }],
      outputs: ['delivery_receipt'],
      suggested_tools: [],
    },
  ],
  edges: [
    { from: 'scraper', to: 'summarizer', payload: 'raw_papers' },
    { from: 'summarizer', to: 'emailer', payload: 'summary' },
  ],
  execution_order: ['scraper', 'summarizer', 'emailer'],
  warnings: [],
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-sys-1',
    user_id: 'u-1',
    name: 'arXiv System',
    status: 'draft',
    kind: 'system',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 's-1',
    project_id: 'p-sys-1',
    raw_prompt: 'arxiv',
    structured_spec: SYSTEM_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'pending',
    kind: 'system',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'pl-1',
    project_id: 'p-sys-1',
    spec_id: 's-1',
    plan: ORCH_PLAN as unknown as Plan['plan'],
    status: 'pending',
    feedback: null,
    kind: 'system',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 'b-1',
    project_id: 'p-sys-1',
    spec_id: 's-1',
    plan_id: 'pl-1',
    phase: 'codegen',
    status: 'queued',
    logs: [],
    repo_url: null,
    deploy_url: null,
    kind: 'system',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: 'rt-1',
    project_id: 'p-sys-1',
    build_id: 'b-1',
    mode: 'schedule',
    schedule_cron: '*/5 * * * *',
    status: 'active',
    next_run_at: null,
    last_run_at: null,
    run_count: 0,
    fail_count: 0,
    consecutive_fails: 0,
    max_run_ms: 60_000,
    env_encrypted: null,
    env_keys: [],
    kind: 'system',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SYSTEM journey — per-status cursor mapping.
// ---------------------------------------------------------------------------

describe('deriveJourney(kind="system")', () => {
  it('intake stage with no spec → cursor on Spec', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: null,
      plan: null,
      build: null,
      runtime: null,
    });
    expect(j.cursor.id).toBe('spec');
    expect(j.cursor.status).toBe('current');
    expect(j.isLive).toBe(false);
    // Deploy is NEVER skipped for systems — even when the spec
    // declares a schedule trigger.
    const deploy = j.stages.find((s) => s.id === 'deploy');
    expect(deploy?.status).not.toBe('skipped');
  });

  it('spec awaiting_review → cursor on Spec', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'awaiting_review' }),
      plan: null,
      build: null,
      runtime: null,
    });
    expect(j.cursor.id).toBe('spec');
    expect(j.cursor.detail).toBe('awaiting review');
  });

  it('spec confirmed + no plan → cursor on Plan (ready to plan)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: null,
      build: null,
      runtime: null,
    });
    expect(j.cursor.id).toBe('plan');
    expect(j.cursor.detail).toBe('ready to plan');
  });

  it('plan awaiting_review → cursor on Plan', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'awaiting_review' }),
      build: null,
      runtime: null,
    });
    expect(j.cursor.id).toBe('plan');
    expect(j.cursor.detail).toBe('awaiting approval');
  });

  it('plan approved + no build → cursor on Code (ready to generate)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: null,
      runtime: null,
    });
    expect(j.cursor.id).toBe('code');
  });

  it('build generated → cursor on Sandbox', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'generated' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('sandbox');
    expect(j.cursor.detail).toBe('ready to test');
  });

  it('build tested → cursor on Repo (ready to push)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'tested' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('repo');
    expect(j.cursor.detail).toBe('ready to push');
  });

  it('build pushed → cursor on Deploy (awaiting authorisation)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({
        status: 'pushed',
        repo_url: 'https://github.com/x/y',
      }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('deploy');
    expect(j.cursor.detail).toBe('awaiting authorisation');
    // Repo stage is done.
    const repo = j.stages.find((s) => s.id === 'repo');
    expect(repo?.status).toBe('done');
  });

  it('build deployed (no runtime) → live; cursor on Live (on-demand)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({
        status: 'deployed',
        deploy_url: 'https://x.vercel.app',
      }),
      runtime: null,
    });
    expect(j.isLive).toBe(true);
    const deploy = j.stages.find((s) => s.id === 'deploy');
    expect(deploy?.status).toBe('done');
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.status).toBe('done');
    expect(runtimeStage?.detail).toBe('on-demand · live');
  });

  it('build running + active system runtime → live + Live = active', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({
        status: 'running',
        deploy_url: 'https://x.vercel.app',
      }),
      runtime: makeRuntime({ status: 'active', run_count: 7 }),
    });
    expect(j.isLive).toBe(true);
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.status).toBe('done');
    expect(runtimeStage?.detail).toContain('active');
    expect(runtimeStage?.detail).toContain('7 runs');
  });

  it('build running + errored runtime → Live = failed (auto-paused)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'running' }),
      runtime: makeRuntime({ status: 'errored' }),
    });
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.status).toBe('failed');
    expect(runtimeStage?.detail).toBe('auto-paused');
  });

  it('deploy_failed → Live = blocked', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'deploy_failed' }),
      runtime: null,
    });
    const deploy = j.stages.find((s) => s.id === 'deploy');
    expect(deploy?.status).toBe('failed');
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.status).toBe('blocked');
  });

  it('system deploy is NEVER skipped (even with schedule trigger)', () => {
    // Phase 1 agents with schedule trigger SKIP deploy; Phase 2
    // systems must NEVER skip deploy. The fixture spec declares
    // triggers: ['schedule'].
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'pushed' }),
      runtime: null,
    });
    const deploy = j.stages.find((s) => s.id === 'deploy');
    expect(deploy?.status).not.toBe('skipped');
    expect(deploy?.status).toBe('current');
  });
});

// ---------------------------------------------------------------------------
// AGENT journey baseline — proves Phase 1 presentation is unchanged.
// We assert the exact same outputs the existing Phase 1 dry-run
// implicitly relies on.
// ---------------------------------------------------------------------------

describe('deriveJourney(kind="agent") — Phase 1 unchanged', () => {
  function agentProject(): Project {
    return {
      id: 'p-agent-1',
      user_id: 'u-1',
      name: 'My Agent',
      status: 'draft',
      kind: 'agent',
      created_at: new Date().toISOString(),
    };
  }
  function agentSpec(status: Spec['status']): Spec {
    return {
      id: 's-agent-1',
      project_id: 'p-agent-1',
      raw_prompt: 'do x',
      structured_spec: {
        name: 'a',
        goal: 'g',
        description: 'd',
        trigger: 'schedule',
        runtime: 'on_demand',
        inputs: [],
        capabilities: [],
        outputs: [],
        constraints: [],
        success_criteria: [],
        risk: 'low',
        confidence: 1,
      },
      open_questions: [],
      feedback: null,
      status,
      kind: 'agent',
      created_at: new Date().toISOString(),
    };
  }

  it('schedule-trigger agent SKIPS deploy (Phase 1 invariant)', () => {
    const j = deriveJourney({
      project: agentProject(),
      spec: agentSpec('confirmed'),
      plan: null,
      build: null,
      runtime: null,
    });
    const deploy = j.stages.find((s) => s.id === 'deploy');
    // The exact Phase 1 semantic: schedule-trigger agents skip Vercel
    // deploy entirely. System behaviour DIVERGES here; that's
    // tested above. This assertion locks the agent baseline.
    expect(deploy?.status).toBe('skipped');
    expect(deploy?.detail).toBe('routed to runtime');
  });

  it('intake-only agent has correct cursor (Phase 1 baseline)', () => {
    const j = deriveJourney({
      project: agentProject(),
      spec: null,
      plan: null,
      build: null,
      runtime: null,
    });
    expect(j.cursor.id).toBe('spec');
    expect(j.isLive).toBe(false);
    expect(j.isRuntimeMode).toBe(false);
  });
});
