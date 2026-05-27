// Hermetic end-to-end dry-run — Phase 2 (Systems) PUSH + DEPLOY.
//
// Companion to system-sandbox-dryrun.test.ts. That file drives the
// sandbox side and stops at 'tested'; this file picks up at 'tested'
// and drives:
//
//   1. POST /system/build/push with { authorized: true }
//      → reuses Phase 1 `pushBuildToGitHub` (STUBBED); build → 'pushed'
//   2. POST /system/build/deploy with { authorized: true, secrets }
//      → reuses Phase 1 `deployBuildToVercel` (STUBBED); build → 'deployed'
//   3. STOP: confirm runtime is still closed for kind='system' (no
//      agent_runtimes row appears; the Phase 1 push/deploy loaders
//      both 409 the system build).
//
// "BOTH gates required" — proven directly by invoking the route
// handler with `{ authorized: false }` (and with no body at all) and
// asserting a 403, then again with `{ authorized: true }` and
// asserting the action proceeds.
//
// NO real network. NO real DB. NO real spend.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Build, BuildFile, Plan, Project, Spec } from '@/lib/types';
import {
  SystemSpecSchema,
  type SystemSpec,
} from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Module-level boundary mocks. Set BEFORE importing the route handlers.
// ---------------------------------------------------------------------------

// Auth: the routes call requireUser + requireProjectOwnership. We
// stub both with a synthetic user that owns a single seeded project.
const FAKE_USER = { id: 'user-sys-deploy-dry-run', email: 'test@example.com' };
const PROJECT_ID = 'project-sys-deploy-dry-run';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    requireUser: vi.fn(async () => FAKE_USER),
    requireProjectOwnership: vi.fn(async (id: string) => {
      // The route only reads .project off the returned object; we
      // hand back a minimal shape the route's downstream code is OK
      // with. The actual project row lookup happens via the in-memory
      // supabase client.
      return {
        project: {
          id,
          user_id: FAKE_USER.id,
          name: 'arXiv System',
          status: 'tested',
          kind: 'system',
          created_at: new Date().toISOString(),
        } as Project,
      };
    }),
  };
});

// Governance: tolerate the route's pre-flight `assertAllowed` call.
vi.mock('@/lib/engine/governance/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/governance/guard')>();
  return {
    ...actual,
    assertAllowed: vi.fn(async () => undefined),
  };
});

// Integrations — the stubbable seams. Stubs default to a happy
// outcome; individual tests can swap behaviour with mockReturnValue.
vi.mock('@/lib/engine/integrations/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/integrations/github')>();
  return {
    ...actual,
    pushBuildToGitHub: vi.fn(),
  };
});
vi.mock('@/lib/engine/integrations/vercel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/integrations/vercel')>();
  return {
    ...actual,
    deployBuildToVercel: vi.fn(),
  };
});

// Connections: the routes call loadConnectionWithToken('github' | 'vercel').
// We stub it to return a synthetic connection row + opaque token.
vi.mock('@/lib/engine/integrations/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/integrations/connections')>();
  return {
    ...actual,
    loadConnectionWithToken: vi.fn(),
  };
});

// Supabase: every route call routes through getServerSupabase(). We
// swap it for the in-memory client built per-test. Using a holder so
// `beforeEach` can swap the DB without re-mocking.
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

import { pushBuildToGitHub } from '@/lib/engine/integrations/github';
import { deployBuildToVercel } from '@/lib/engine/integrations/vercel';
import {
  loadConnectionWithToken,
  type ConnectionPublic,
} from '@/lib/engine/integrations/connections';

function fakeGithubConn(): { row: ConnectionPublic; token: string } {
  return {
    row: {
      id: 'conn-gh-1',
      user_id: FAKE_USER.id,
      provider: 'github',
      account_login: 'forge-tester',
      scopes: null,
      key_last4: null,
      created_at: new Date().toISOString(),
    },
    token: 'gho_test',
  };
}

function fakeVercelConn(): { row: ConnectionPublic; token: string } {
  return {
    row: {
      id: 'conn-vc-1',
      user_id: FAKE_USER.id,
      provider: 'vercel',
      account_login: 'forge-tester',
      scopes: null,
      key_last4: null,
      created_at: new Date().toISOString(),
    },
    token: 'vt_test',
  };
}

// Import the route handlers AFTER the mocks are set up.
import { POST as systemPushPOST } from '@/app/api/projects/[id]/system/build/push/route';
import { POST as systemDeployPOST } from '@/app/api/projects/[id]/system/build/deploy/route';
import { POST as agentPushPOST } from '@/app/api/projects/[id]/build/push/route';
import { POST as agentDeployPOST } from '@/app/api/projects/[id]/build/deploy/route';

// ---------------------------------------------------------------------------
// Canned data.
// ---------------------------------------------------------------------------

const CANNED_SYSTEM_SPEC: SystemSpec = SystemSpecSchema.parse({
  goal: 'arxiv pipeline',
  sub_agents: [
    {
      id: 'scraper',
      role: 'scraper',
      description: 'pulls listings',
      inputs: ['time_window'],
      outputs: ['raw_papers'],
    },
    {
      id: 'summarizer',
      role: 'summarizer',
      description: 'summarises',
      inputs: ['raw_papers'],
      outputs: ['summary'],
    },
    {
      id: 'emailer',
      role: 'emailer',
      description: 'emails',
      inputs: ['summary'],
      outputs: ['delivery_receipt'],
    },
  ],
  coordination: { pattern: 'pipeline' },
  triggers: ['schedule'],
});

const CANNED_ORCH_PLAN: OrchestrationPlan = OrchestrationPlanSchema.parse({
  goal: 'arxiv pipeline',
  pattern: 'pipeline',
  max_steps: CANNED_SYSTEM_SPEC.max_steps,
  nodes: [
    {
      id: 'scraper',
      role: 'scraper',
      task: 'fetch arxiv',
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
      task: 'summarise',
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
      task: 'email',
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

// ---------------------------------------------------------------------------
// Seed helpers — build the (project, spec, plan, build, files) chain
// at a chosen build.status so each test can pick up where it needs to.
// ---------------------------------------------------------------------------

function seedSystem(
  db: InMemoryDb,
  buildStatus: 'tested' | 'pushed' = 'tested',
  repoUrl: string | null = null,
): { project: Project; spec: Spec; plan: Plan; build: Build; files: BuildFile[] } {
  const project: Project = {
    id: PROJECT_ID,
    user_id: FAKE_USER.id,
    name: 'arXiv System',
    status: 'plan_approved',
    kind: 'system',
    created_at: new Date().toISOString(),
  };
  const spec: Spec = {
    id: 'spec-sys-deploy-1',
    project_id: project.id,
    raw_prompt: 'arxiv',
    structured_spec: CANNED_SYSTEM_SPEC as unknown as Spec['structured_spec'],
    open_questions: [],
    feedback: null,
    status: 'confirmed',
    kind: 'system',
    created_at: new Date().toISOString(),
  };
  const plan: Plan = {
    id: 'plan-sys-deploy-1',
    project_id: project.id,
    spec_id: spec.id,
    plan: CANNED_ORCH_PLAN as unknown as Plan['plan'],
    status: 'approved',
    feedback: null,
    kind: 'system',
    created_at: new Date().toISOString(),
  };
  const build: Build = {
    id: 'build-sys-deploy-1',
    project_id: project.id,
    spec_id: spec.id,
    plan_id: plan.id,
    phase: 'codegen',
    status: buildStatus,
    logs: { static_checks: [], warnings: [] } as unknown as Build['logs'],
    repo_url: repoUrl,
    deploy_url: null,
    kind: 'system',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const files: BuildFile[] = [
    {
      id: 'f-1',
      build_id: build.id,
      path: 'src/orchestrator.ts',
      content: '// orchestrator\n',
      source: 'generated',
      bytes: 20,
      created_at: new Date().toISOString(),
    },
    {
      id: 'f-2',
      build_id: build.id,
      path: 'src/modules/scraper/index.ts',
      content: '// scraper\n',
      source: 'generated',
      bytes: 15,
      created_at: new Date().toISOString(),
    },
  ];

  db.tables.projects = [project as unknown as Record<string, unknown>];
  db.tables.specs = [spec as unknown as Record<string, unknown>];
  db.tables.plans = [plan as unknown as Record<string, unknown>];
  db.tables.builds = [build as unknown as Record<string, unknown>];
  db.tables.build_files = files.map((f) => f as unknown as Record<string, unknown>);
  return { project, spec, plan, build, files };
}

// Convenience: build a Request that matches what Next.js hands the
// route handler in production.
function makePost(body: unknown): Request {
  return new Request('http://test/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(pushBuildToGitHub).mockReset();
  vi.mocked(deployBuildToVercel).mockReset();
  vi.mocked(loadConnectionWithToken).mockReset();
  dbHolder.current = null;
});

describe('Phase 2 SYSTEM push + deploy hermetic dry-run', () => {
  // ========================================================================
  // PASSING PATH — both gates fire; tested → pushed → deployed.
  // ========================================================================
  it('happy path: tested → push (gate) → pushed → deploy (gate) → deployed', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { build } = seedSystem(db, 'tested');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeGithubConn());

    vi.mocked(pushBuildToGitHub).mockResolvedValue({
      repo_url: 'https://github.com/forge-tester/arxiv-system',
      repo_name: 'arxiv-system',
      owner: 'forge-tester',
      commit_sha: 'abc123',
      default_branch: 'main',
      files_pushed: 2,
    });

    const pushRes = await systemPushPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(pushRes.status).toBe(200);
    const pushBody = (await pushRes.json()) as {
      status: string;
      kind: string;
      repo_url: string;
    };
    expect(pushBody.status).toBe('pushed');
    expect(pushBody.kind).toBe('system');
    expect(pushBody.repo_url).toMatch(/github\.com/);

    // Build row → 'pushed' with repo_url persisted.
    const afterPush = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(afterPush?.status).toBe('pushed');
    expect(afterPush?.repo_url).toBe('https://github.com/forge-tester/arxiv-system');

    // Audit log shows the push trail.
    const auditAfterPush = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(auditAfterPush.some((r) => r.action === 'system.push_authorized')).toBe(true);
    expect(auditAfterPush.some((r) => r.action === 'system.pushed')).toBe(true);

    // Now deploy gate. Swap the connection to vercel + script the deploy.
    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());
    vi.mocked(deployBuildToVercel).mockResolvedValue({
      project_ref: 'prj_test',
      project_name: 'arxiv-system',
      deployment_id: 'dpl_test',
      deployment_url: 'https://arxiv-system.vercel.app',
      env_keys_set: ['ANTHROPIC_API_KEY', 'RESEND_API_KEY'],
      ready_state: 'READY',
    });

    const deployRes = await systemDeployPOST(
      makePost({
        authorized: true,
        secrets: {
          ANTHROPIC_API_KEY: 'sk-test-anth',
          RESEND_API_KEY: 'rk-test',
        },
      }),
      { params: { id: PROJECT_ID } },
    );
    expect(deployRes.status).toBe(200);
    const deployBody = (await deployRes.json()) as {
      status: string;
      kind: string;
      url: string;
    };
    expect(deployBody.status).toBe('deployed');
    expect(deployBody.kind).toBe('system');
    expect(deployBody.url).toBe('https://arxiv-system.vercel.app');

    const afterDeploy = (db.tables.builds ?? []).find((r) => r.id === build.id) as
      | Build
      | undefined;
    expect(afterDeploy?.status).toBe('deployed');
    expect(afterDeploy?.deploy_url).toBe('https://arxiv-system.vercel.app');

    // deployments row reaches 'ready'.
    const deployments = (db.tables.deployments ?? []) as Array<Record<string, unknown>>;
    expect(deployments).toHaveLength(1);
    expect(deployments[0]?.status).toBe('ready');
    expect(deployments[0]?.url).toBe('https://arxiv-system.vercel.app');

    // Audit log shows the full trail.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'system.deploy_authorized')).toBe(true);
    expect(audit.some((r) => r.action === 'system.deployed')).toBe(true);

    // BOTH integration helpers fired exactly once.
    expect(vi.mocked(pushBuildToGitHub)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(1);

    // STOP — system runtime activation is NOT a Phase 2-5a entry point.
    expect((db.tables.agent_runtimes ?? []).length).toBe(0);
    expect((db.tables.runs ?? []).length).toBe(0);
  });

  // ========================================================================
  // GATE GUARDS — both routes refuse a body without { authorized: true }.
  // ========================================================================
  it('push route refuses missing { authorized: true } with 403; pushBuildToGitHub never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSystem(db, 'tested');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeGithubConn());

    // Empty body → 400 (invalid json). Add a minimal-shape body to
    // get to the schema check.
    const noFlagRes = await systemPushPOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(noFlagRes.status).toBe(403);

    const explicitFalseRes = await systemPushPOST(
      makePost({ authorized: false }),
      { params: { id: PROJECT_ID } },
    );
    expect(explicitFalseRes.status).toBe(403);

    // Critically: the integration helper was never called. The build
    // stays in 'tested' — no clobber.
    expect(vi.mocked(pushBuildToGitHub)).toHaveBeenCalledTimes(0);
    const build = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(build?.status).toBe('tested');
    expect(build?.repo_url).toBeNull();
  });

  it('deploy route refuses missing { authorized: true } with 403; deployBuildToVercel never called', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    // Seed at 'pushed' since deploy preconditions require it.
    seedSystem(db, 'pushed', 'https://github.com/forge-tester/arxiv-system');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());

    const noFlagRes = await systemDeployPOST(makePost({}), {
      params: { id: PROJECT_ID },
    });
    expect(noFlagRes.status).toBe(403);

    const explicitFalseRes = await systemDeployPOST(
      makePost({ authorized: false, secrets: { ANTHROPIC_API_KEY: 'x' } }),
      { params: { id: PROJECT_ID } },
    );
    expect(explicitFalseRes.status).toBe(403);

    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
    const build = (db.tables.builds ?? [])[0] as Build | undefined;
    expect(build?.status).toBe('pushed');
    expect(build?.deploy_url).toBeNull();
  });

  // ========================================================================
  // MISROUTES — the Phase 1 push/deploy loaders 409 a system build.
  // ========================================================================
  it('Phase 1 push route 409s a system build with the system-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSystem(db, 'tested');

    const res = await agentPushPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/system build/i);
    expect(body.error).toMatch(/system\/build\/push/i);
  });

  it('Phase 1 deploy route 409s a system build with the system-route hint', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSystem(db, 'pushed', 'https://github.com/forge-tester/arxiv-system');

    const res = await agentDeployPOST(
      makePost({ authorized: true, secrets: {} }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/system build/i);
    expect(body.error).toMatch(/system\/build\/deploy/i);
  });

  // ========================================================================
  // STATUS GATES — the system push refuses non-'tested' (or
  // 'push_failed' for retry); the system deploy refuses non-'pushed'.
  // ========================================================================
  it('system push refuses a build that is still generated', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    seedSystem(db, 'tested');
    // Patch in-place to 'generated' to simulate trying to push too early.
    (db.tables.builds?.[0] as unknown as Build).status = 'generated';

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeGithubConn());

    const res = await systemPushPOST(makePost({ authorized: true }), {
      params: { id: PROJECT_ID },
    });
    expect(res.status).toBe(409);
    expect(vi.mocked(pushBuildToGitHub)).toHaveBeenCalledTimes(0);
  });

  it('system deploy refuses a build that has not been pushed', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    // Seed at 'tested' — deploy should refuse, deploy needs 'pushed'.
    seedSystem(db, 'tested');

    vi.mocked(loadConnectionWithToken).mockResolvedValue(fakeVercelConn());

    const res = await systemDeployPOST(
      makePost({ authorized: true, secrets: {} }),
      { params: { id: PROJECT_ID } },
    );
    expect(res.status).toBe(409);
    expect(vi.mocked(deployBuildToVercel)).toHaveBeenCalledTimes(0);
  });

  // ========================================================================
  // Hermeticity.
  // ========================================================================
  it('zero real fetch calls across the whole system push/deploy dry-run', () => {
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    expect(f.mock.calls.length).toBe(0);
  });
});
