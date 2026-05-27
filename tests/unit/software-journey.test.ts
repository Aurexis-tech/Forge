// Unit test: deriveJourney(kind='software') maps every software
// status to the right stage cursor — including the new 'provisioning'
// / 'provisioned' / 'provision_failed' states added in Phase 3-5a and
// the 'running' = "live" state added in Phase 3-6.
//
// Also locks AGENT + SYSTEM journey output as BIT-IDENTICAL — the
// existing system-journey.test.ts baselines are re-asserted here too,
// so a future refactor that accidentally drifted the agent/system
// path would fail both tests.

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
  SoftwareSpecSchema,
  type SoftwareSpec,
} from '@/lib/engine/software/spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '@/lib/engine/software/planner/schema';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const SOFTWARE_SPEC: SoftwareSpec = SoftwareSpecSchema.parse({
  goal: 'Team expenses tracker',
  pages: [
    { id: 'submit_expense', name: 'Submit', purpose: 'Submit an expense.' },
  ],
  entities: [
    {
      name: 'Expense',
      fields: [
        { name: 'submitted_by', type: 'reference' },
        { name: 'amount', type: 'number' },
      ],
    },
  ],
  flows: [
    {
      name: 'Submit',
      description: 'submit an expense',
      pages: ['submit_expense'],
    },
  ],
  auth: { requires_auth: true, per_user_isolation: true },
});

const SOFTWARE_PLAN: SoftwareBuildPlan = SoftwareBuildPlanSchema.parse({
  template_id: 'nextjs-supabase-app',
  tasks: [
    {
      id: 'migration_expense',
      layer: 'schema',
      description: 'x',
      depends_on: [],
      slot: { kind: 'entity_migration', target: 'Expense' },
      files: [],
    },
  ],
  execution_order: ['migration_expense'],
  warnings: [],
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-sw-1',
    user_id: 'u-1',
    name: 'Team Expenses',
    status: 'draft',
    kind: 'software',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 's-1',
    project_id: 'p-sw-1',
    raw_prompt: 'expenses tracker',
    structured_spec: SOFTWARE_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'pending',
    kind: 'software',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'pl-1',
    project_id: 'p-sw-1',
    spec_id: 's-1',
    plan: SOFTWARE_PLAN as unknown as Plan['plan'],
    status: 'pending',
    feedback: null,
    kind: 'software',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 'b-1',
    project_id: 'p-sw-1',
    spec_id: 's-1',
    plan_id: 'pl-1',
    phase: 'codegen',
    status: 'queued',
    logs: [],
    repo_url: null,
    deploy_url: null,
    kind: 'software',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
function makeSoftwareRuntime(
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  return {
    id: 'rt-1',
    project_id: 'p-sw-1',
    build_id: 'b-1',
    mode: 'always_on',
    schedule_cron: '@always',
    status: 'active',
    next_run_at: null,
    last_run_at: null,
    run_count: 0,
    fail_count: 0,
    consecutive_fails: 0,
    max_run_ms: 60_000,
    env_encrypted: null,
    env_keys: [],
    kind: 'software',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SOFTWARE journey — per-status cursor mapping.
// ---------------------------------------------------------------------------

describe('deriveJourney(kind="software")', () => {
  it('software journey has 8 stages with provision replacing repo', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: null,
      plan: null,
      build: null,
      runtime: null,
    });
    expect(j.stages).toHaveLength(8);
    const ids = j.stages.map((s) => s.id);
    expect(ids).toEqual([
      'intent',
      'spec',
      'plan',
      'code',
      'sandbox',
      'provision',
      'deploy',
      'runtime',
    ]);
    // 'provision' is software-only — it does NOT appear in agent or
    // system journeys.
    expect(ids).toContain('provision');
    expect(ids).not.toContain('repo');
  });

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
    expect(j.isRuntimeMode).toBe(false);
  });

  it('spec confirmed + no plan → cursor on Plan', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: null,
      build: null,
      runtime: null,
    });
    expect(j.cursor.id).toBe('plan');
  });

  it('plan approved + no build → cursor on Code', () => {
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
  });

  it('build tested → cursor on Database (provision, awaiting provision)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'tested' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('provision');
    expect(j.cursor.label).toBe('Database');
    expect(j.cursor.detail).toBe('awaiting provision');
  });

  it('build provisioning → cursor on Database (in-flight)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'provisioning' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('provision');
    expect(j.cursor.detail).toBe('provisioning…');
  });

  it('build provision_failed → Database = failed; downstream pending', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'provision_failed' }),
      runtime: null,
    });
    const provision = j.stages.find((s) => s.id === 'provision');
    expect(provision?.status).toBe('failed');
    const deploy = j.stages.find((s) => s.id === 'deploy');
    expect(deploy?.status).toBe('pending');
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.status).toBe('pending');
  });

  it('build provisioned → cursor on Deploy (awaiting push)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'provisioned' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('deploy');
    expect(j.cursor.detail).toBe('awaiting push');
    const provision = j.stages.find((s) => s.id === 'provision');
    expect(provision?.status).toBe('done');
    expect(provision?.detail).toBe('schema applied ✓');
  });

  it('build pushed → cursor on Deploy (awaiting deploy)', () => {
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
    expect(j.cursor.detail).toBe('awaiting deploy');
  });

  it('build deployed (no runtime) → cursor on Live (awaiting go-live); NOT live yet', () => {
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
    // Software is NOT live until the user marks the app live via the
    // P3-6 gate. Different from system (which is "on-demand live" the
    // moment deploy completes).
    expect(j.isLive).toBe(false);
    expect(j.cursor.id).toBe('runtime');
    expect(j.cursor.detail).toBe('awaiting go-live');
    const deploy = j.stages.find((s) => s.id === 'deploy');
    expect(deploy?.status).toBe('done');
  });

  it('build running + active software runtime → live + Live = done', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({
        status: 'running',
        deploy_url: 'https://x.vercel.app',
      }),
      runtime: makeSoftwareRuntime({ status: 'active' }),
    });
    expect(j.isLive).toBe(true);
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.status).toBe('done');
    expect(runtimeStage?.detail).toBe('live');
  });

  it('build running + paused (kill-switch) software runtime → isLive=true but Live=failed (offline)', () => {
    // Paused-by-killswitch still counts as a configured live runtime
    // (isLive=true), but the stage reads as failed/offline so the UI
    // surfaces the "needs attention" cue.
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'running' }),
      runtime: makeSoftwareRuntime({ status: 'paused' }),
    });
    expect(j.isLive).toBe(true);
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.status).toBe('failed');
    expect(runtimeStage?.detail).toBe('offline · paused');
  });

  it('software journey ignores agent-kind runtime rows (kind safety)', () => {
    // A stale agent-kind runtime row attached to a software project
    // (extremely defensive — would only happen via direct row
    // manipulation) must NOT mark the software journey live.
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'deployed', deploy_url: 'https://x.vercel.app' }),
      runtime: makeSoftwareRuntime({ kind: 'agent', status: 'active' }),
    });
    expect(j.isLive).toBe(false);
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.detail).toBe('awaiting go-live');
  });

  it('deploy_failed → Live = blocked (deploy first)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'deploy_failed' }),
      runtime: null,
    });
    const runtimeStage = j.stages.find((s) => s.id === 'runtime');
    expect(runtimeStage?.status).toBe('blocked');
    expect(runtimeStage?.detail).toBe('deploy first');
  });

  it('test_failed → Sandbox = failed; downstream pending', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'test_failed' }),
      runtime: null,
    });
    const sandbox = j.stages.find((s) => s.id === 'sandbox');
    expect(sandbox?.status).toBe('failed');
    const provision = j.stages.find((s) => s.id === 'provision');
    expect(provision?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// BIT-IDENTICAL BASELINES — Phase 1 (agent) + Phase 2 (system) journey
// output is UNCHANGED by the Phase 3 software extension.
// ---------------------------------------------------------------------------

describe('agent + system journey baselines unchanged by Phase 3', () => {
  it('agent journey still has 8 stages and uses "repo" (not "provision")', () => {
    const project: Project = {
      id: 'p-a',
      user_id: 'u-1',
      name: 'a',
      status: 'draft',
      kind: 'agent',
      created_at: new Date().toISOString(),
    };
    const j = deriveJourney({
      project,
      spec: null,
      plan: null,
      build: null,
      runtime: null,
    });
    expect(j.stages).toHaveLength(8);
    const ids = j.stages.map((s) => s.id);
    expect(ids).toEqual([
      'intent',
      'spec',
      'plan',
      'code',
      'sandbox',
      'repo',
      'deploy',
      'runtime',
    ]);
    expect(ids).not.toContain('provision');
  });

  it('system journey still has 8 stages and uses "repo" (not "provision")', () => {
    const project: Project = {
      id: 'p-s',
      user_id: 'u-1',
      name: 's',
      status: 'draft',
      kind: 'system',
      created_at: new Date().toISOString(),
    };
    const j = deriveJourney({
      project,
      spec: null,
      plan: null,
      build: null,
      runtime: null,
    });
    expect(j.stages).toHaveLength(8);
    const ids = j.stages.map((s) => s.id);
    expect(ids).toEqual([
      'intent',
      'spec',
      'plan',
      'code',
      'sandbox',
      'repo',
      'deploy',
      'runtime',
    ]);
    expect(ids).not.toContain('provision');
  });

  it('agent schedule-trigger → deploy still SKIPPED (Phase 1 invariant)', () => {
    const j = deriveJourney({
      project: {
        id: 'p-a',
        user_id: 'u-1',
        name: 'a',
        status: 'draft',
        kind: 'agent',
        created_at: new Date().toISOString(),
      },
      spec: {
        id: 's-a',
        project_id: 'p-a',
        raw_prompt: 'x',
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
        status: 'confirmed',
        kind: 'agent',
        created_at: new Date().toISOString(),
      },
      plan: null,
      build: null,
      runtime: null,
    });
    const deploy = j.stages.find((s) => s.id === 'deploy');
    expect(deploy?.status).toBe('skipped');
    expect(deploy?.detail).toBe('routed to runtime');
  });
});
