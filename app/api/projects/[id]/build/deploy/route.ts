// Deploy a 'pushed' build to Vercel — second human authorisation gate.
//
// HARD RULES enforced here (defence in depth — the UI must already match):
// - Request body MUST carry `authorized: true`. No `authorized:false` or
//   missing flag is ever accepted.
// - build.status MUST be 'pushed' (or 'deploy_failed' for retry).
// - plan.runtime_impl MUST be 'on_demand' AND spec.trigger MUST NOT be
//   'schedule'. Always-on / scheduled agents are routed to the runtime
//   layer and refused here.
// - A second deploy is refused while one is in flight ('deploying' / a
//   sibling deployments row with status 'deploying' younger than 15 min).
//
// SECRETS in the body:
// - The route receives a `secrets` map (key → value). These are forwarded
//   to Vercel's env API and then dropped. They are NEVER logged, NEVER
//   echoed back, and only the KEY NAMES are persisted (deployments.env_keys).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireProjectOwnership, requireUser, UnauthorizedError } from '@/lib/auth';
import { assertAllowed, GovernanceError, governanceBlockResponse } from '@/lib/engine/governance/guard';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import {
  VercelDeployError,
  deployBuildToVercel,
  type VercelEnvVar,
} from '@/lib/engine/integrations/vercel';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { getServerSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  Deployment,
  Plan,
  Spec,
} from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 600;

const SecretsSchema = z.record(z.string().min(1), z.string().max(8000));

const BodySchema = z.object({
  authorized: z.literal(true),
  // Optional map of env key → value. The deploy route mixes these with the
  // plan's env_required list before pushing to Vercel.
  secrets: SecretsSchema.optional(),
});

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;

  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  const ownership = await requireProjectOwnership(projectId, user);
  if ('error' in ownership) {
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }
  const project = ownership.project;

  try {
    await assertAllowed({ user_id: user.id, project_id: projectId, projectedCostUsd: 0 });
  } catch (err) {
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      return NextResponse.json(body, { status });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'request body must include { "authorized": true } — the user must explicitly approve the deploy',
      },
      { status: 403 },
    );
  }
  const incomingSecrets = parsed.data.secrets ?? {};

  const supabase = getServerSupabase();

  const { data: builds } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1);
  const build = (builds?.[0] as Build | undefined) ?? null;
  if (!build) {
    return NextResponse.json({ error: 'project has no build' }, { status: 409 });
  }
  // Defence in depth — Phase 1 deploy only handles agent builds.
  // Phase 2 systems route through /api/projects/[id]/system/build/deploy;
  // Phase 3 software routes through /api/projects/[id]/software/build/deploy.
  if (build.kind === 'system') {
    return NextResponse.json(
      {
        error:
          "this is a system build (kind='system'). Use /api/projects/[id]/system/build/deploy for the system deploy.",
      },
      { status: 409 },
    );
  }
  if (build.kind === 'software') {
    return NextResponse.json(
      {
        error:
          "this is a software build (kind='software'). Use /api/projects/[id]/software/build/deploy for the software deploy.",
      },
      { status: 409 },
    );
  }
  if (build.kind && build.kind !== 'agent') {
    return NextResponse.json(
      {
        error:
          "this build has kind='" +
          build.kind +
          "' which has no deploy path in this phase.",
      },
      { status: 409 },
    );
  }
  if (build.status !== 'pushed' && build.status !== 'deploy_failed') {
    return NextResponse.json(
      {
        error:
          "build is in status '" +
          build.status +
          "'; only 'pushed' (or 'deploy_failed' for retry) can be deployed",
      },
      { status: 409 },
    );
  }
  if (!build.plan_id || !build.spec_id) {
    return NextResponse.json(
      { error: 'build is missing plan_id or spec_id' },
      { status: 422 },
    );
  }

  // --- Load + re-validate plan/spec ---------------------------------------
  const { data: specRow } = await supabase
    .from('specs')
    .select('*')
    .eq('id', build.spec_id)
    .single();
  const spec = (specRow as Spec | null) ?? null;
  if (!spec) return NextResponse.json({ error: 'spec missing' }, { status: 422 });
  const parsedSpec = AgentSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return NextResponse.json(
      { error: 'spec no longer matches schema' },
      { status: 422 },
    );
  }
  const agentSpec: AgentSpec = parsedSpec.data;

  const { data: planRow } = await supabase
    .from('plans')
    .select('*')
    .eq('id', build.plan_id)
    .single();
  const plan = (planRow as Plan | null) ?? null;
  if (!plan) return NextResponse.json({ error: 'plan missing' }, { status: 422 });
  const parsedPlan = BuildPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return NextResponse.json(
      { error: 'plan no longer matches schema' },
      { status: 422 },
    );
  }
  const buildPlan: BuildPlan = parsedPlan.data;

  // --- always_on / scheduled gate ----------------------------------------
  if (
    buildPlan.runtime_impl === 'always_on' ||
    agentSpec.trigger === 'schedule'
  ) {
    return NextResponse.json(
      {
        error:
          'this agent runs continuously or on a schedule and is not deployable via the on-demand path; route it through the runtime layer',
        runtime_impl: buildPlan.runtime_impl,
        trigger: agentSpec.trigger,
      },
      { status: 409 },
    );
  }

  // --- Concurrency --------------------------------------------------------
  const conc = await checkDeployConcurrency(supabase, build.id);
  if ('error' in conc) {
    return NextResponse.json({ error: conc.error }, { status: conc.status });
  }

  // --- Connection ---------------------------------------------------------
  const conn = await loadConnectionWithToken(supabase, 'vercel', user.id);
  if (!conn) {
    return NextResponse.json(
      { error: 'Vercel is not connected; complete the connect flow first' },
      { status: 412 },
    );
  }
  const teamId = parseTeamId(conn.row.scopes);

  // --- Files --------------------------------------------------------------
  const { data: filesData, error: filesErr } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  if (filesErr) {
    return NextResponse.json({ error: filesErr.message }, { status: 500 });
  }
  const files = (filesData ?? []) as BuildFile[];
  if (files.length === 0) {
    return NextResponse.json({ error: 'build has no files' }, { status: 422 });
  }

  // --- Merge env: plan-declared + incoming secrets ------------------------
  const envForVercel = mergeEnv(buildPlan.env_required, incomingSecrets);
  const envKeysSet = envForVercel.map((e) => e.key);

  // --- Audit BEFORE acting (so consent is recorded even on a crash) ------
  await supabase.from('audit_log').insert({
    project_id: projectId,
    action: 'deploy.authorized',
    actor: 'user',
    detail: {
      build_id: build.id,
      account_login: conn.row.account_login,
      env_keys: envKeysSet,
      files_count: files.length,
    },
  });

  // --- Mark in flight + insert deployments row ----------------------------
  await supabase.from('builds').update({ status: 'deploying' }).eq('id', build.id);
  const { data: deploymentRow, error: depRowErr } = await supabase
    .from('deployments')
    .insert({
      build_id: build.id,
      provider: 'vercel',
      status: 'deploying',
      env_keys: envKeysSet,
    })
    .select('*')
    .single();
  if (depRowErr || !deploymentRow) {
    return NextResponse.json(
      { error: depRowErr?.message ?? 'failed to insert deployment row' },
      { status: 500 },
    );
  }
  const depId = (deploymentRow as Deployment).id;

  // --- Deploy -------------------------------------------------------------
  try {
    const result = await deployBuildToVercel({
      token: conn.token,
      teamId,
      projectName: project.name,
      framework: buildPlan.target.framework,
      files,
      env: envForVercel,
    });

    await supabase
      .from('builds')
      .update({ status: 'deployed', deploy_url: result.deployment_url })
      .eq('id', build.id);

    await supabase
      .from('deployments')
      .update({
        status: 'ready',
        project_ref: result.project_ref,
        deployment_id: result.deployment_id,
        url: result.deployment_url,
        env_keys: result.env_keys_set,
      })
      .eq('id', depId);

    await supabase.from('audit_log').insert({
      project_id: projectId,
      action: 'deploy.created',
      actor: 'integration.vercel',
      detail: {
        build_id: build.id,
        deployment_id: result.deployment_id,
        project_ref: result.project_ref,
        project_name: result.project_name,
      },
    });
    await supabase.from('audit_log').insert({
      project_id: projectId,
      action: 'deploy.completed',
      actor: 'integration.vercel',
      detail: {
        build_id: build.id,
        deployment_id: result.deployment_id,
        url: result.deployment_url,
        env_keys: result.env_keys_set,
      },
    });

    return NextResponse.json({
      status: 'deployed',
      url: result.deployment_url,
      project_ref: result.project_ref,
      deployment_id: result.deployment_id,
    });
  } catch (err) {
    const isV = err instanceof VercelDeployError;
    const message = err instanceof Error ? err.message : String(err);
    const logTail = isV ? (err as VercelDeployError).logTail ?? null : null;

    await supabase
      .from('builds')
      .update({ status: 'deploy_failed' })
      .eq('id', build.id);

    await supabase
      .from('deployments')
      .update({ status: 'failed' })
      .eq('id', depId);

    await supabase.from('audit_log').insert({
      project_id: projectId,
      action: 'deploy.failed',
      actor: 'integration.vercel',
      detail: {
        build_id: build.id,
        error: message,
        log_tail: logTail ? logTail.slice(-2000) : null,
      },
    });

    return NextResponse.json(
      { error: message, log_tail: logTail },
      { status: 502 },
    );
  }
}

// --- Helpers ---------------------------------------------------------------

interface DeploymentRowSlice {
  id: string;
  status: string | null;
  created_at: string;
}

async function checkDeployConcurrency(
  supabase: ReturnType<typeof getServerSupabase>,
  buildId: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const { data } = await supabase
    .from('deployments')
    .select('id, status, created_at')
    .eq('build_id', buildId)
    .eq('status', 'deploying')
    .order('created_at', { ascending: false })
    .limit(1);
  const latest = (data?.[0] as DeploymentRowSlice | undefined) ?? null;
  if (!latest) return { ok: true };
  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  if (ageMs < 15 * 60_000) {
    return {
      error:
        'a deployment is already in flight for this build (deployment ' +
        latest.id.slice(0, 8) +
        ')',
      status: 409,
    };
  }
  // Zombie reaping: an old 'deploying' row is treated as failed before a fresh
  // one starts. This keeps the build from being permanently locked.
  await supabase
    .from('deployments')
    .update({ status: 'failed' })
    .eq('id', latest.id);
  return { ok: true };
}

function parseTeamId(scopes: string | null): string | null {
  if (!scopes) return null;
  if (scopes.startsWith('team:')) return scopes.slice('team:'.length);
  return null;
}

function mergeEnv(
  envRequired: BuildPlan['env_required'],
  incomingSecrets: Record<string, string>,
): VercelEnvVar[] {
  const out: VercelEnvVar[] = [];
  const seen = new Set<string>();

  // First: every env declared by the plan, using the user-supplied value if
  // provided. We accept secrets for non-secret slots too (the UI is one form).
  for (const e of envRequired) {
    const value = incomingSecrets[e.key];
    if (e.secret && !value) {
      // A secret with no value is a programming error in the UI flow — the
      // server has no way to fill it. Skip rather than silently leak the slot
      // with empty value; the deploy will likely fail at runtime, which is
      // the correct signal.
      continue;
    }
    if (value === undefined) continue;
    seen.add(e.key);
    out.push({ key: e.key, value, secret: e.secret });
  }

  // Then: any extra secrets the user supplied that weren't in the plan. We
  // assume secret semantics for safety.
  for (const [key, value] of Object.entries(incomingSecrets)) {
    if (seen.has(key)) continue;
    if (!value) continue;
    out.push({ key, value, secret: true });
  }

  return out;
}
