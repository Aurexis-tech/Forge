// Unit test: deriveJourney(kind='infrastructure') maps every infra
// status to the right stage cursor — including the lifecycle from
// previewing/previewed/preview_blocked → planning/plan_confirmed/
// plan_blocked → applying/provisioned/apply_failed → destroying/
// destroyed.
//
// Also locks AGENT + SYSTEM + SOFTWARE journey outputs as
// BIT-IDENTICAL — the existing journey baselines are re-asserted
// here so a future refactor that drifted any of the three earlier
// derivations fails this test loudly.

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
  InfraSpecSchema,
  type InfraSpec,
} from '@/lib/engine/infra/spec';
import {
  ProvisioningPlanSchema,
  type ProvisioningPlan,
} from '@/lib/engine/infra/planner/schema';

const INFRA_SPEC: InfraSpec = InfraSpecSchema.parse({
  goal: 'pipeline',
  region: 'us-east-1',
  lifecycle: 'persistent',
  resources: [
    { id: 'events_db', type: 'postgres_db', config: {} },
    { id: 'ingest_worker', type: 'worker', config: {} },
  ],
  topology: [{ from: 'ingest_worker', to: 'events_db' }],
});

const INFRA_PLAN: ProvisioningPlan = ProvisioningPlanSchema.parse({
  catalog_version: 'v1',
  steps: [
    {
      id: 'network_private_subnets',
      layer: 'network',
      module: 'private_network',
      description: 'x',
      depends_on: [],
      config: {},
      resource_id: null,
      secure_defaults: [],
    },
    {
      id: 'network_service_identity',
      layer: 'network',
      module: 'service_identity',
      description: 'x',
      depends_on: ['network_private_subnets'],
      config: {},
      resource_id: null,
      secure_defaults: [],
    },
  ],
  execution_order: ['network_private_subnets', 'network_service_identity'],
  warnings: [],
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-infra-1',
    user_id: 'u-1',
    name: 'Ingest',
    status: 'draft',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 's-1',
    project_id: 'p-infra-1',
    raw_prompt: 'pipeline',
    structured_spec: INFRA_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'pending',
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'pl-1',
    project_id: 'p-infra-1',
    spec_id: 's-1',
    plan: INFRA_PLAN as unknown as Plan['plan'],
    status: 'pending',
    feedback: null,
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 'b-1',
    project_id: 'p-infra-1',
    spec_id: 's-1',
    plan_id: 'pl-1',
    phase: 'codegen',
    status: 'queued',
    logs: [],
    repo_url: null,
    deploy_url: null,
    kind: 'infrastructure',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('deriveJourney(kind="infrastructure")', () => {
  it('infra journey has 8 stages with preview + confirm + apply + live', () => {
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
      'preview',
      'confirm',
      'deploy',
      'runtime',
    ]);
    // Infra-specific ids that don't appear in other kinds.
    expect(ids).toContain('preview');
    expect(ids).toContain('confirm');
    // Infra-only — does NOT carry agent/system 'repo' or software
    // 'provision' (despite reusing the 'provision' identifier — see
    // below).
    expect(ids).not.toContain('repo');
    expect(ids).not.toContain('sandbox');
  });

  it('intake → cursor on Spec', () => {
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

  it('plan approved + no build → cursor on Code (IaC)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: null,
      runtime: null,
    });
    expect(j.cursor.id).toBe('code');
  });

  it('build generated → cursor on Preview', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'generated' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('preview');
    expect(j.cursor.detail).toBe('awaiting preview');
  });

  it('build previewing → Preview in-flight', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'previewing' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('preview');
    expect(j.cursor.detail).toBe('previewing…');
  });

  it('build preview_blocked → Preview failed (over budget)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'preview_blocked' }),
      runtime: null,
    });
    const preview = j.stages.find((s) => s.id === 'preview');
    expect(preview?.status).toBe('failed');
    expect(preview?.detail).toBe('over budget');
    // Downstream stays pending.
    const confirm = j.stages.find((s) => s.id === 'confirm');
    expect(confirm?.status).toBe('pending');
  });

  it('build previewed → cursor on Confirm (awaiting real plan)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'previewed' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('confirm');
    expect(j.cursor.detail).toBe('awaiting real plan');
  });

  it('build planning → Confirm in-flight', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'planning' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('confirm');
    expect(j.cursor.detail).toBe('real plan in flight');
  });

  it('build plan_blocked → Confirm failed (over budget on real plan)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'plan_blocked' }),
      runtime: null,
    });
    const confirm = j.stages.find((s) => s.id === 'confirm');
    expect(confirm?.status).toBe('failed');
    expect(confirm?.detail).toContain('over budget');
  });

  it('build plan_confirmed → cursor on Apply', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'plan_confirmed' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('deploy');
    expect(j.cursor.label).toBe('Apply');
    expect(j.cursor.detail).toBe('awaiting apply');
  });

  it('build applying → Apply in-flight', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'applying' }),
      runtime: null,
    });
    expect(j.cursor.id).toBe('deploy');
    expect(j.cursor.detail).toContain('applying');
  });

  it('build apply_failed → Apply failed; downstream pending', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'apply_failed' }),
      runtime: null,
    });
    const deploy = j.stages.find((s) => s.id === 'deploy');
    expect(deploy?.status).toBe('failed');
    expect(deploy?.detail).toContain('partial state');
    const live = j.stages.find((s) => s.id === 'runtime');
    expect(live?.status).toBe('pending');
    expect(j.isLive).toBe(false);
  });

  it('build provisioned → Live = monitored; isLive=true', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'provisioned' }),
      runtime: null,
    });
    expect(j.isLive).toBe(true);
    const live = j.stages.find((s) => s.id === 'runtime');
    expect(live?.status).toBe('done');
    expect(live?.detail).toBe('monitored');
  });

  it('build destroying → Live = current (tearing down)', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'destroying' }),
      runtime: null,
    });
    expect(j.isLive).toBe(false);
    expect(j.cursor.id).toBe('runtime');
    expect(j.cursor.detail).toContain('tearing down');
  });

  it('build destroyed → Live = done (with destroyed detail); isLive=false', () => {
    const j = deriveJourney({
      project: makeProject(),
      spec: makeSpec({ status: 'confirmed' }),
      plan: makePlan({ status: 'approved' }),
      build: makeBuild({ status: 'destroyed' }),
      runtime: null,
    });
    // Terminal: isLive=false (the resources are gone). The journey
    // reads as "complete → destroyed" — Live is done, detail says so.
    expect(j.isLive).toBe(false);
    const live = j.stages.find((s) => s.id === 'runtime');
    expect(live?.status).toBe('done');
    expect(live?.detail).toBe('destroyed');
  });
});

// ---------------------------------------------------------------------------
// BIT-IDENTICAL BASELINES — Phase 1 (agent) + Phase 2 (system) +
// Phase 3 (software) journey outputs UNCHANGED by Phase 4-6.
// ---------------------------------------------------------------------------

describe('agent + system + software journey baselines unchanged by Phase 4-6', () => {
  function project(kind: 'agent' | 'system' | 'software'): Project {
    return {
      id: 'p-' + kind,
      user_id: 'u-1',
      name: 'x',
      status: 'draft',
      kind,
      created_at: new Date().toISOString(),
    };
  }

  it('agent journey still 8 stages with repo (no preview/confirm/provision)', () => {
    const j = deriveJourney({
      project: project('agent'),
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
    expect(ids).not.toContain('preview');
    expect(ids).not.toContain('confirm');
    expect(ids).not.toContain('provision');
  });

  it('system journey still 8 stages with repo (no preview/confirm/provision)', () => {
    const j = deriveJourney({
      project: project('system'),
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
    expect(ids).not.toContain('preview');
    expect(ids).not.toContain('confirm');
  });

  it('software journey still 8 stages with provision (no preview/confirm)', () => {
    const j = deriveJourney({
      project: project('software'),
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
    expect(ids).not.toContain('preview');
    expect(ids).not.toContain('confirm');
    expect(ids).not.toContain('repo');
  });

  it('agent schedule-trigger still SKIPS deploy (Phase 1 invariant)', () => {
    const j = deriveJourney({
      project: project('agent'),
      spec: {
        id: 's-a',
        project_id: 'p-agent',
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

  it('software deployed (no runtime) → cursor on Live (awaiting go-live)', () => {
    const j = deriveJourney({
      project: project('software'),
      spec: {
        id: 's-sw',
        project_id: 'p-software',
        raw_prompt: 'x',
        structured_spec: {
          goal: 'sw',
          pages: [{ id: 'p1', name: 'P', purpose: 'p' }],
          entities: [{ name: 'E', fields: [] }],
          flows: [{ name: 'F', description: 'd', pages: ['p1'] }],
          auth: { requires_auth: true, per_user_isolation: true },
        },
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'software',
        created_at: new Date().toISOString(),
      },
      plan: {
        id: 'pl-sw',
        project_id: 'p-software',
        spec_id: 's-sw',
        plan: {
          template_id: 'nextjs-supabase-app',
          tasks: [],
          execution_order: [],
          warnings: [],
        },
        status: 'approved',
        feedback: null,
        kind: 'software',
        created_at: new Date().toISOString(),
      },
      build: {
        id: 'b-sw',
        project_id: 'p-software',
        spec_id: 's-sw',
        plan_id: 'pl-sw',
        phase: 'codegen',
        status: 'deployed',
        logs: [],
        repo_url: null,
        deploy_url: 'https://x.vercel.app',
        kind: 'software',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      runtime: null,
    });
    expect(j.isLive).toBe(false);
    expect(j.cursor.id).toBe('runtime');
    expect(j.cursor.detail).toBe('awaiting go-live');
  });

  it('system runtime active still reads as live + Live=active', () => {
    const runtime: AgentRuntime = {
      id: 'rt',
      project_id: 'p-system',
      build_id: 'b-sys',
      mode: 'schedule',
      schedule_cron: '*/5 * * * *',
      status: 'active',
      next_run_at: null,
      last_run_at: null,
      run_count: 3,
      fail_count: 0,
      consecutive_fails: 0,
      max_run_ms: 60_000,
      env_encrypted: null,
      env_keys: [],
      kind: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const j = deriveJourney({
      project: project('system'),
      spec: {
        id: 's-sys',
        project_id: 'p-system',
        raw_prompt: 'x',
        structured_spec: {
          goal: 'sys',
          sub_agents: [
            {
              id: 'a',
              role: 'a',
              description: 'x',
              inputs: [],
              outputs: ['o'],
            },
          ],
          coordination: { pattern: 'pipeline' },
          triggers: ['schedule'],
        },
        open_questions: [],
        feedback: null,
        status: 'confirmed',
        kind: 'system',
        created_at: new Date().toISOString(),
      },
      plan: null,
      build: {
        id: 'b-sys',
        project_id: 'p-system',
        spec_id: 's-sys',
        plan_id: 'pl-sys',
        phase: 'codegen',
        status: 'running',
        logs: [],
        repo_url: null,
        deploy_url: 'https://x.vercel.app',
        kind: 'system',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      runtime,
    });
    expect(j.isLive).toBe(true);
    const live = j.stages.find((s) => s.id === 'runtime');
    expect(live?.status).toBe('done');
    expect(live?.detail).toContain('active');
  });
});
