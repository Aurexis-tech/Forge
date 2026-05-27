// DB helpers for the Phase 2 (Systems) push + deploy harness. Same
// shape as lib/engine/integrations/* + the route-level persistence in
// the Phase 1 push/deploy routes; both write into the SAME builds +
// deployments tables. A deployment's "kind" is derivable through
// `builds.kind` — no extra discriminator column is needed.
//
// IMPORTANT: a system build STOPS after deploy in this phase. There's
// no system runtime activation path; runtime activation lands in P2-5b.
// The Phase 1 push/deploy loaders refuse non-agent builds with 409,
// and the loaders below refuse anything that isn't kind='system' at
// the right status.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  Deployment,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { SystemSpecSchema, type SystemSpec } from '../spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '../planner/schema';
import { TOOL_REGISTRY } from '@/lib/engine/planner/registry';
import type { BuildPlan } from '@/lib/engine/planner/schema';

// ---------------------------------------------------------------------------
// Shared chain loader — returns the project + system build + spec +
// plan + files in one call. The push and deploy routes use this with
// different "acceptable build statuses" so a misroute fails closed
// before the route touches GitHub or Vercel.
// ---------------------------------------------------------------------------

export interface SystemIntegrationContext {
  project: Project;
  build: Build;
  spec: SystemSpec;
  plan: OrchestrationPlan;
  files: BuildFile[];
}

interface LoadOpts {
  acceptableStatuses: ReadonlyArray<string>;
}

async function loadSystemBuildChain(
  supabase: ForgeSupabase,
  projectId: string,
  opts: LoadOpts,
): Promise<SystemIntegrationContext | { error: string; status: number }> {
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projErr || !project) return { error: 'project not found', status: 404 };

  // The latest build SCOPED to kind='system'. Defensive — a project
  // only ever has one kind of build, but a cross-kind row would be a
  // sharp edge. We peek at the latest UNSCOPED build first so a
  // software project landing at the system route gets a clear
  // "use the software route" 409 instead of a generic "no system build".
  const { data: anyBuilds } = await supabase
    .from('builds')
    .select('kind')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1);
  const latestAnyKind = (anyBuilds?.[0] as { kind?: string } | undefined)?.kind;
  if (latestAnyKind === 'software') {
    return {
      error:
        "this is a software build (kind='software'). Use /api/projects/[id]/software/build/push (or /software/build/deploy) for the software pipeline.",
      status: 409,
    };
  }
  if (latestAnyKind === 'agent') {
    return {
      error:
        "this is an agent build (kind='agent'). Use /api/projects/[id]/build/push (or /build/deploy) for the agent pipeline.",
      status: 409,
    };
  }

  const { data: builds } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'system')
    .order('created_at', { ascending: false })
    .limit(1);
  const build = (builds?.[0] as Build | undefined) ?? null;
  if (!build) return { error: 'project has no system build', status: 409 };

  if (!opts.acceptableStatuses.includes(build.status)) {
    return {
      error:
        "system build is in status '" +
        build.status +
        "'; expected one of " +
        opts.acceptableStatuses.map((s) => "'" + s + "'").join(', '),
      status: 409,
    };
  }
  if (!build.spec_id || !build.plan_id) {
    return { error: 'system build is missing spec_id or plan_id', status: 422 };
  }

  const { data: specRow } = await supabase
    .from('specs')
    .select('*')
    .eq('id', build.spec_id)
    .single();
  const spec = (specRow as Spec | null) ?? null;
  if (!spec) return { error: 'build references a missing spec', status: 422 };
  if (spec.kind !== 'system') {
    return {
      error:
        "build references a non-system spec (kind='" + spec.kind + "')",
      status: 409,
    };
  }
  const parsedSpec = SystemSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return {
      error: 'stored SystemSpec no longer matches the current schema',
      status: 422,
    };
  }

  const { data: planRow } = await supabase
    .from('plans')
    .select('*')
    .eq('id', build.plan_id)
    .single();
  const plan = (planRow as Plan | null) ?? null;
  if (!plan) return { error: 'build references a missing plan', status: 422 };
  if (plan.kind !== 'system') {
    return {
      error: "build references a non-system plan (kind='" + plan.kind + "')",
      status: 422,
    };
  }
  const parsedPlan = OrchestrationPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return {
      error: 'stored OrchestrationPlan no longer matches the current schema',
      status: 422,
    };
  }

  const { data: filesData, error: filesErr } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  if (filesErr) {
    return { error: filesErr.message, status: 500 };
  }
  const files = (filesData ?? []) as BuildFile[];
  if (files.length === 0) {
    return { error: 'system build has no files', status: 422 };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files,
  };
}

// Push: only 'tested' (or 'push_failed' for retry).
export async function loadTestedSystemBuildForPush(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SystemIntegrationContext | { error: string; status: number }> {
  return loadSystemBuildChain(supabase, projectId, {
    acceptableStatuses: ['tested', 'push_failed'],
  });
}

// Deploy: only 'pushed' (or 'deploy_failed' for retry).
export async function loadPushedSystemBuildForDeploy(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SystemIntegrationContext | { error: string; status: number }> {
  return loadSystemBuildChain(supabase, projectId, {
    acceptableStatuses: ['pushed', 'deploy_failed'],
  });
}

// ---------------------------------------------------------------------------
// Status flips. Build status is the single source of truth the page +
// routes key off; we keep the verbs distinct from the agent path's
// helpers so a future reader can grep for them.
// ---------------------------------------------------------------------------

export async function markSystemBuildPushing(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase.from('builds').update({ status: 'pushing' }).eq('id', buildId);
}

export async function markSystemBuildPushed(
  supabase: ForgeSupabase,
  buildId: string,
  repoUrl: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'pushed', repo_url: repoUrl })
    .eq('id', buildId);
}

export async function markSystemBuildPushFailed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'push_failed' })
    .eq('id', buildId);
}

export async function markSystemBuildDeploying(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'deploying' })
    .eq('id', buildId);
}

export async function markSystemBuildDeployed(
  supabase: ForgeSupabase,
  buildId: string,
  deployUrl: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'deployed', deploy_url: deployUrl })
    .eq('id', buildId);
}

export async function markSystemBuildDeployFailed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'deploy_failed' })
    .eq('id', buildId);
}

// ---------------------------------------------------------------------------
// Deployments table — mirror the agent flow. Concurrency check + insert
// + update helpers; deployment.kind is derivable through builds.kind so
// no schema change is needed.
// ---------------------------------------------------------------------------

interface DeploymentRowSlice {
  id: string;
  status: string | null;
  created_at: string;
}

export async function checkSystemDeployConcurrency(
  supabase: ForgeSupabase,
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
        'a deployment is already in flight for this system build (deployment ' +
        latest.id.slice(0, 8) +
        ')',
      status: 409,
    };
  }
  // Zombie reaping.
  await supabase
    .from('deployments')
    .update({ status: 'failed' })
    .eq('id', latest.id);
  return { ok: true };
}

export async function insertSystemDeploymentRow(
  supabase: ForgeSupabase,
  buildId: string,
  envKeys: string[],
): Promise<Deployment> {
  const { data, error } = await supabase
    .from('deployments')
    .insert({
      build_id: buildId,
      provider: 'vercel',
      status: 'deploying',
      env_keys: envKeys,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert system deployment row');
  }
  return data as Deployment;
}

export async function markSystemDeploymentReady(
  supabase: ForgeSupabase,
  deploymentId: string,
  args: {
    project_ref: string;
    deployment_id: string;
    url: string;
    env_keys: string[];
  },
): Promise<void> {
  await supabase
    .from('deployments')
    .update({
      status: 'ready',
      project_ref: args.project_ref,
      deployment_id: args.deployment_id,
      url: args.url,
      env_keys: args.env_keys,
    })
    .eq('id', deploymentId);
}

export async function markSystemDeploymentFailed(
  supabase: ForgeSupabase,
  deploymentId: string,
): Promise<void> {
  await supabase
    .from('deployments')
    .update({ status: 'failed' })
    .eq('id', deploymentId);
}

// ---------------------------------------------------------------------------
// Env aggregation — the system has no single env_required field; we
// derive one from the union of `suggested_tools[].env_keys` across all
// nodes in the OrchestrationPlan, grounded against the TOOL_REGISTRY
// so a stale plan can't ask for env keys the registry doesn't actually
// use. Shape matches the Phase 1 BuildPlan.env_required so the reused
// DeployFlow + deploy integration can consume it as-is.
// ---------------------------------------------------------------------------

export function aggregateSystemEnvRequired(
  plan: OrchestrationPlan,
): BuildPlan['env_required'] {
  const seen = new Set<string>();
  const out: BuildPlan['env_required'] = [];
  for (const node of plan.nodes) {
    for (const tool of node.suggested_tools) {
      if (tool.registry_id === null) continue;
      const entry = TOOL_REGISTRY.find((r) => r.id === tool.registry_id);
      if (!entry) continue;
      for (const key of tool.env_keys) {
        if (seen.has(key)) continue;
        if (!entry.env_keys.includes(key)) continue;
        seen.add(key);
        out.push({
          key,
          why:
            "Required by tool '" +
            tool.registry_id +
            "' used in node '" +
            node.id +
            "'.",
          // All TOOL_REGISTRY env_keys are treated as secrets — they
          // gate access to a third-party service.
          secret: true,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit-log helpers.
// ---------------------------------------------------------------------------

export async function logSystemPushAuthorized(
  supabase: ForgeSupabase,
  build: Build,
  accountLogin: string,
  filesCount: number,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.push_authorized',
    actor: 'user',
    detail: {
      build_id: build.id,
      account_login: accountLogin,
      files_count: filesCount,
    },
  });
}

export async function logSystemPushed(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    repo_url: string;
    repo_name: string;
    owner: string;
    commit_sha: string;
    files_pushed: number;
    default_branch: string;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.pushed',
    actor: 'integration.github',
    detail: {
      build_id: build.id,
      ...args,
      private: true,
    },
  });
}

export async function logSystemPushFailed(
  supabase: ForgeSupabase,
  build: Build,
  message: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.push_failed',
    actor: 'integration.github',
    detail: { build_id: build.id, error: message },
  });
}

export async function logSystemDeployAuthorized(
  supabase: ForgeSupabase,
  build: Build,
  accountLogin: string | null,
  envKeys: string[],
  filesCount: number,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.deploy_authorized',
    actor: 'user',
    detail: {
      build_id: build.id,
      account_login: accountLogin,
      env_keys: envKeys,
      files_count: filesCount,
    },
  });
}

export async function logSystemDeployed(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    deployment_id: string;
    project_ref: string;
    project_name: string;
    deploy_url: string;
    env_keys: string[];
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.deployed',
    actor: 'integration.vercel',
    detail: {
      build_id: build.id,
      ...args,
    },
  });
}

export async function logSystemDeployFailed(
  supabase: ForgeSupabase,
  build: Build,
  message: string,
  logTail: string | null,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.deploy_failed',
    actor: 'integration.vercel',
    detail: {
      build_id: build.id,
      error: message,
      log_tail: logTail ? logTail.slice(-2000) : null,
    },
  });
}
