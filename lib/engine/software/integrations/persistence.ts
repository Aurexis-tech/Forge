// DB helpers for the Phase 3 (Software) push + deploy harness. Same
// shape as lib/engine/system/integrations/persistence.ts; both write
// into the SAME builds + deployments tables. A deployment's "kind" is
// derivable through `builds.kind` — no extra discriminator column is
// needed.
//
// IMPORTANT: software stops AT deploy in P3-5b — the runtime layer
// for kind='software' lands in P3-6. The Phase 1/2 push/deploy
// loaders refuse non-(agent|system) builds with 409, and the loaders
// below refuse anything that isn't kind='software' at the right
// status.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  Deployment,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { SoftwareSpecSchema, type SoftwareSpec } from '../spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '../planner/schema';

// ---------------------------------------------------------------------------
// Shared chain loader — returns the project + software build + spec +
// plan + files in one call. The push and deploy routes use this with
// different "acceptable build statuses" so a misroute fails closed
// before the route touches GitHub or Vercel.
// ---------------------------------------------------------------------------

export interface SoftwareIntegrationContext {
  project: Project;
  build: Build;
  spec: SoftwareSpec;
  plan: SoftwareBuildPlan;
  files: BuildFile[];
}

interface LoadOpts {
  acceptableStatuses: ReadonlyArray<string>;
}

async function loadSoftwareBuildChain(
  supabase: ForgeSupabase,
  projectId: string,
  opts: LoadOpts,
): Promise<SoftwareIntegrationContext | { error: string; status: number }> {
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projErr || !project) return { error: 'project not found', status: 404 };

  const { data: builds } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'software')
    .order('created_at', { ascending: false })
    .limit(1);
  const build = (builds?.[0] as Build | undefined) ?? null;
  if (!build) return { error: 'project has no software build', status: 409 };

  if (!opts.acceptableStatuses.includes(build.status)) {
    return {
      error:
        "software build is in status '" +
        build.status +
        "'; expected one of " +
        opts.acceptableStatuses.map((s) => "'" + s + "'").join(', '),
      status: 409,
    };
  }
  if (!build.spec_id || !build.plan_id) {
    return {
      error: 'software build is missing spec_id or plan_id',
      status: 422,
    };
  }

  const { data: specRow } = await supabase
    .from('specs')
    .select('*')
    .eq('id', build.spec_id)
    .single();
  const spec = (specRow as Spec | null) ?? null;
  if (!spec) return { error: 'build references a missing spec', status: 422 };
  if (spec.kind !== 'software') {
    return {
      error:
        "build references a non-software spec (kind='" + spec.kind + "')",
      status: 409,
    };
  }
  const parsedSpec = SoftwareSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return {
      error: 'stored SoftwareSpec no longer matches the current schema',
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
  if (plan.kind !== 'software') {
    return {
      error: "build references a non-software plan (kind='" + plan.kind + "')",
      status: 422,
    };
  }
  const parsedPlan = SoftwareBuildPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return {
      error: 'stored SoftwareBuildPlan no longer matches the current schema',
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
    return { error: 'software build has no files', status: 422 };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files,
  };
}

// Push: only 'provisioned' (P3-5a complete) or 'push_failed' for retry.
// Pushing before provision would deploy code with no DB to point at, so
// 'tested' is intentionally NOT acceptable here.
export async function loadProvisionedSoftwareBuildForPush(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SoftwareIntegrationContext | { error: string; status: number }> {
  return loadSoftwareBuildChain(supabase, projectId, {
    acceptableStatuses: ['provisioned', 'push_failed'],
  });
}

// Deploy: only 'pushed' (or 'deploy_failed' for retry).
export async function loadPushedSoftwareBuildForDeploy(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SoftwareIntegrationContext | { error: string; status: number }> {
  return loadSoftwareBuildChain(supabase, projectId, {
    acceptableStatuses: ['pushed', 'deploy_failed'],
  });
}

// ---------------------------------------------------------------------------
// Status flips. Build status is the single source of truth the page +
// routes key off; verbs are software-distinct so a future reader can
// grep for them.
// ---------------------------------------------------------------------------

export async function markSoftwareBuildPushing(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase.from('builds').update({ status: 'pushing' }).eq('id', buildId);
}

export async function markSoftwareBuildPushed(
  supabase: ForgeSupabase,
  buildId: string,
  repoUrl: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'pushed', repo_url: repoUrl })
    .eq('id', buildId);
}

export async function markSoftwareBuildPushFailed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'push_failed' })
    .eq('id', buildId);
}

export async function markSoftwareBuildDeploying(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'deploying' })
    .eq('id', buildId);
}

export async function markSoftwareBuildDeployed(
  supabase: ForgeSupabase,
  buildId: string,
  deployUrl: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'deployed', deploy_url: deployUrl })
    .eq('id', buildId);
}

export async function markSoftwareBuildDeployFailed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'deploy_failed' })
    .eq('id', buildId);
}

// ---------------------------------------------------------------------------
// Deployments table — mirror the system flow. Concurrency check +
// insert + update helpers; deployment.kind is derivable through
// builds.kind so no schema change is needed.
// ---------------------------------------------------------------------------

interface DeploymentRowSlice {
  id: string;
  status: string | null;
  created_at: string;
}

export async function checkSoftwareDeployConcurrency(
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
        'a deployment is already in flight for this software build (deployment ' +
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

export async function insertSoftwareDeploymentRow(
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
    throw error ?? new Error('failed to insert software deployment row');
  }
  return data as Deployment;
}

export async function markSoftwareDeploymentReady(
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

export async function markSoftwareDeploymentFailed(
  supabase: ForgeSupabase,
  deploymentId: string,
): Promise<void> {
  await supabase
    .from('deployments')
    .update({ status: 'failed' })
    .eq('id', deploymentId);
}

// ---------------------------------------------------------------------------
// Audit-log helpers. NEVER pass the raw service-role key into the
// detail blob — the deploy route handles that secret via the
// software_databases row + decryptServiceRole, and ONLY uses it for
// the actual Vercel env set call.
// ---------------------------------------------------------------------------

export async function logSoftwarePushAuthorized(
  supabase: ForgeSupabase,
  build: Build,
  accountLogin: string,
  filesCount: number,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.push_authorized',
    actor: 'user',
    detail: {
      build_id: build.id,
      account_login: accountLogin,
      files_count: filesCount,
    },
  });
}

export async function logSoftwarePushed(
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
    action: 'software.pushed',
    actor: 'integration.github',
    detail: {
      build_id: build.id,
      ...args,
      private: true,
    },
  });
}

export async function logSoftwarePushFailed(
  supabase: ForgeSupabase,
  build: Build,
  message: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.push_failed',
    actor: 'integration.github',
    detail: { build_id: build.id, error: message },
  });
}

export async function logSoftwareDeployAuthorized(
  supabase: ForgeSupabase,
  build: Build,
  accountLogin: string | null,
  // env_keys ONLY — never values. The audit detail blob is reachable
  // by audit_log readers; values stay off it by construction.
  envKeys: string[],
  filesCount: number,
  // For belt-and-braces visibility: which env keys were classified
  // public (NEXT_PUBLIC_*) vs server-only. Helps an auditor confirm
  // the service-role landed on the server-only side.
  publicKeys: string[],
  serverOnlyKeys: string[],
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.deploy_authorized',
    actor: 'user',
    detail: {
      build_id: build.id,
      account_login: accountLogin,
      env_keys: envKeys,
      env_public_keys: publicKeys,
      env_server_only_keys: serverOnlyKeys,
      files_count: filesCount,
    },
  });
}

export async function logSoftwareDeployed(
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
    action: 'software.deployed',
    actor: 'integration.vercel',
    detail: {
      build_id: build.id,
      ...args,
    },
  });
}

export async function logSoftwareDeployFailed(
  supabase: ForgeSupabase,
  build: Build,
  message: string,
  logTail: string | null,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.deploy_failed',
    actor: 'integration.vercel',
    detail: {
      build_id: build.id,
      error: message,
      log_tail: logTail ? logTail.slice(-2000) : null,
    },
  });
}
