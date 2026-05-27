// DB helpers for the Phase 3-6 (Software) runtime. Same shape as
// lib/engine/system/runtime/persistence.ts; both modules read + write
// the SAME agent_runtimes table, distinguished by the `kind` column
// (extended in 0022_software_runtime.sql to include 'software').
//
// IMPORTANT — software runtimes do NOT spawn runs. A software app
// "running" means the deployed Vercel URL is reachable and the kill
// switch hasn't taken it offline. The runtime row exists ONLY as:
//
//   1. A persistent marker that the user has authorised the app to
//      go live (the P3-6 gate is recorded as the row's existence).
//   2. A target the kill switch flips status → 'paused' on so the
//      dashboard reads "offline" without any code change.
//
// Because there's no per-run lifecycle, this module deliberately
// omits the run insertion / finishRunRow helpers the agent + system
// paths use. The shared scheduler's `.lte('next_run_at', now)` query
// skips software rows because we leave next_run_at NULL.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  AgentRuntime,
  Build,
  Deployment,
  Plan,
  Project,
  SoftwareDatabase,
  Spec,
} from '@/lib/types';
import { activeKillSwitch } from '@/lib/engine/governance/killswitch';
import { SoftwareSpecSchema, type SoftwareSpec } from '../spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '../planner/schema';

export interface SoftwareRuntimeContext {
  project: Project;
  build: Build;
  spec: SoftwareSpec;
  plan: SoftwareBuildPlan;
}

// Loads the (project → latest kind='software' build → spec → plan)
// chain the go-live route needs. Files aren't required — the runtime
// row carries nothing executable.
export async function loadDeployedSoftwareBuildForActivate(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SoftwareRuntimeContext | { error: string; status: number }> {
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

  // Activation requires 'deployed' or 'running' (the latter so a
  // re-activation after the runtime was stopped works the same way
  // the system path's loader does).
  if (build.status !== 'deployed' && build.status !== 'running') {
    return {
      error:
        "software build is in status '" +
        build.status +
        "'; go-live requires 'deployed' or 'running'",
      status: 409,
    };
  }
  if (!build.spec_id || !build.plan_id) {
    return { error: 'software build is missing spec_id or plan_id', status: 422 };
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

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
  };
}

// Load the latest kind='software' runtime row for a project. Mirrors
// loadSystemRuntimeForProject — explicit kind filter so a project
// that's pivoted kinds can't show the wrong row.
export async function loadSoftwareRuntimeForProject(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<AgentRuntime | null> {
  const { data, error } = await supabase
    .from('agent_runtimes')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'software')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentRuntime | null) ?? null;
}

export interface CreateSoftwareRuntimeInput {
  project: Project;
  build: Build;
}

// Insert a kind='software' agent_runtimes row + flip build.status to
// 'running'. NO env is stored (the env was wired into Vercel during
// the deploy step; the runtime row doesn't need it). NO schedule —
// the deployed app serves continuously at its Vercel URL.
export async function createSoftwareRuntime(
  supabase: ForgeSupabase,
  input: CreateSoftwareRuntimeInput,
): Promise<AgentRuntime> {
  const { data, error } = await supabase
    .from('agent_runtimes')
    .insert({
      project_id: input.project.id,
      build_id: input.build.id,
      kind: 'software',
      mode: 'always_on',
      // Placeholder cron — the column is NOT NULL in 0008_runtime.sql.
      // The shared scheduler never picks software rows (next_run_at
      // stays null), so this string is never parsed.
      schedule_cron: '@always',
      status: 'active',
      next_run_at: null,
      env_encrypted: null,
      env_keys: [],
      // Software runs don't have a tick budget — set to the schema's
      // minimum so the column stays satisfied without implying any
      // executor lifetime.
      max_run_ms: 60_000,
      run_count: 0,
      fail_count: 0,
      consecutive_fails: 0,
      last_run_at: null,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert software agent_runtime');
  }

  // Build moves to 'running' so the page header reflects an active
  // (live) app. On stop, the build returns to 'deployed'.
  await supabase
    .from('builds')
    .update({ status: 'running' })
    .eq('id', input.build.id);

  return data as AgentRuntime;
}

// Flip the runtime status. Mirrors setRuntimeStatus from the agent
// path but always operates on a kind='software' row (the caller's
// concern — we filter by id, not kind).
export async function setSoftwareRuntimeStatus(
  supabase: ForgeSupabase,
  runtimeId: string,
  status: 'active' | 'paused' | 'stopped' | 'errored',
): Promise<void> {
  const { error } = await supabase
    .from('agent_runtimes')
    .update({ status })
    .eq('id', runtimeId);
  if (error) throw error;
}

// When the runtime is stopped, the build returns to 'deployed' (so
// the user can re-activate via the gate). When active/paused/errored,
// the build stays 'running' (the runtime row continues to exist).
export async function setSoftwareBuildStatusFromRuntime(
  supabase: ForgeSupabase,
  buildId: string,
  runtimeStatus: 'active' | 'paused' | 'stopped' | 'errored',
): Promise<void> {
  const buildStatus = runtimeStatus === 'stopped' ? 'deployed' : 'running';
  await supabase
    .from('builds')
    .update({ status: buildStatus })
    .eq('id', buildId);
}

// Sync a software runtime with the kill switch's current state. Call
// this on every dashboard load:
//
//   - If the runtime is 'active' AND a kill switch is active in the
//     applicable set, flip status → 'paused'. The dashboard then
//     surfaces "offline · paused".
//   - If the runtime is 'paused' AND no kill switch is active, leave
//     it paused — the user must explicitly re-go-live via the gate.
//     This avoids silently resurrecting an app the user expected to
//     stay offline.
//
// Returns the (possibly updated) runtime row.
export async function syncSoftwareRuntimeWithKillSwitch(
  supabase: ForgeSupabase,
  runtime: AgentRuntime,
  scope: { userId?: string | null; projectId?: string | null },
): Promise<AgentRuntime> {
  if (runtime.kind !== 'software') return runtime;
  if (runtime.status !== 'active') return runtime;
  const kill = await activeKillSwitch(scope, supabase);
  if (!kill) return runtime;
  await setSoftwareRuntimeStatus(supabase, runtime.id, 'paused');
  return { ...runtime, status: 'paused' };
}

// Audit helpers. NEVER pass env values or service-role keys into
// detail blobs.

export async function logSoftwareRuntimeAuthorized(
  supabase: ForgeSupabase,
  build: Build,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.runtime_authorized',
    actor: 'user',
    detail: { build_id: build.id },
  });
}

export async function logSoftwareRuntimeActivated(
  supabase: ForgeSupabase,
  build: Build,
  runtimeId: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.runtime_activated',
    actor: 'engine.software.runtime',
    detail: { build_id: build.id, runtime_id: runtimeId },
  });
}

export async function logSoftwareRuntimeOffline(
  supabase: ForgeSupabase,
  build: Build,
  runtimeId: string,
  reason: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.runtime_offline',
    actor: 'engine.governance',
    detail: { build_id: build.id, runtime_id: runtimeId, reason },
  });
}

// ---------------------------------------------------------------------------
// Dashboard payload assembly.
//
// The SoftwareAppDashboard component receives ONLY this shape — never
// the raw software_databases row or the runtime's encrypted env blob.
// The service-role-key is not on this type by construction.
// ---------------------------------------------------------------------------

export interface SoftwareDashboardPayload {
  // Top-level header.
  live: boolean;
  // Build + project metadata.
  project_id: string;
  project_name: string;
  build_id: string;
  // Vercel.
  deploy_url: string | null;
  deployment_status: string | null;
  vercel_account_login: string | null;
  // GitHub.
  repo_url: string | null;
  github_account_login: string | null;
  // Database — public-safe fields only. The service-role key is
  // INTENTIONALLY ABSENT from this shape.
  db: {
    provider_kind: string;
    supabase_url: string;
    anon_key_last4: string;
    service_role_last4: string;
    migration_applied: boolean;
    provider_project_ref: string | null;
  } | null;
  // Runtime row state.
  runtime: {
    id: string;
    status: 'active' | 'paused' | 'stopped' | 'errored';
    created_at: string;
  } | null;
  // Kill switch — drives the "go-live blocked" banner.
  kill_switch: {
    active: boolean;
    scope: 'global' | 'user' | 'project' | null;
    reason: string | null;
  };
  // Plain-language summary from the SoftwareSpec.
  summary: {
    goal: string;
    pages: number;
    entities: number;
    requires_auth: boolean;
  };
  // Cost dimensions — honest infra hosting line rather than a
  // fabricated per-run number. The budget/kill-switch still owns the
  // hard stop globally.
  cost_dimensions: ReadonlyArray<{
    label: string;
    detail: string;
  }>;
}

export interface AssembleSoftwareDashboardInput {
  project: Project;
  build: Build;
  spec: SoftwareSpec;
  runtime: AgentRuntime | null;
  db: SoftwareDatabase | null;
  deployment: Deployment | null;
  githubAccountLogin: string | null;
  vercelAccountLogin: string | null;
  killSwitch: {
    active: boolean;
    scope: 'global' | 'user' | 'project' | null;
    reason: string | null;
  };
}

// Public-safe abbreviation for an anon key — first 4 + last 4. The
// anon key is technically PUBLIC (it's bundled into the browser
// bundle), so showing the whole thing wouldn't be a leak; we
// abbreviate purely for UI density.
function abbreviateAnon(s: string): string {
  if (!s) return '';
  return s.length <= 8 ? s : s.slice(-4);
}

export function assembleSoftwareDashboard(
  input: AssembleSoftwareDashboardInput,
): SoftwareDashboardPayload {
  const live =
    input.runtime != null &&
    input.runtime.kind === 'software' &&
    input.runtime.status === 'active' &&
    !input.killSwitch.active;

  return {
    live,
    project_id: input.project.id,
    project_name: input.project.name,
    build_id: input.build.id,
    deploy_url: input.build.deploy_url ?? null,
    deployment_status: input.deployment?.status ?? null,
    vercel_account_login: input.vercelAccountLogin,
    repo_url: input.build.repo_url ?? null,
    github_account_login: input.githubAccountLogin,
    db: input.db
      ? {
          provider_kind: input.db.provider_kind,
          supabase_url: input.db.supabase_url,
          anon_key_last4: abbreviateAnon(input.db.anon_key),
          service_role_last4: input.db.service_role_last4,
          migration_applied: input.db.migration_applied,
          provider_project_ref: input.db.provider_project_ref ?? null,
        }
      : null,
    runtime: input.runtime
      ? {
          id: input.runtime.id,
          status: input.runtime.status as
            | 'active'
            | 'paused'
            | 'stopped'
            | 'errored',
          created_at: input.runtime.created_at,
        }
      : null,
    kill_switch: input.killSwitch,
    summary: {
      goal: input.spec.goal,
      pages: input.spec.pages.length,
      entities: input.spec.entities.length,
      requires_auth: input.spec.auth.requires_auth,
    },
    // Software's true cost shape — hosting + database, not per-run
    // LLM tokens. Don't invent a per-tick number.
    cost_dimensions: [
      {
        label: 'hosting',
        detail: 'Vercel (deployed at the URL above)',
      },
      {
        label: 'database',
        detail:
          input.db?.provider_kind === 'byo'
            ? 'Supabase (bring-your-own project)'
            : 'Supabase (managed via Forge)',
      },
    ] as const,
  };
}
