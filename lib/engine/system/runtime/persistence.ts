// DB helpers for the Phase 2 (Systems) runtime. Same shape as
// lib/engine/runtime/persistence.ts; both modules read + write the
// SAME agent_runtimes + runs tables, distinguished by the `kind`
// column (extended in supabase/migrations/0019_system_runtime.sql).
//
// IMPORTANT — this module is INTAKE-ONLY for system runtimes. The
// per-run lifecycle helpers (insertRunningRunRow, finishRunRow,
// audit) are SHARED with the agent path and live in
// lib/engine/runtime/persistence.ts. We import them through the
// existing module so a system run touches the same tables, the same
// audit channels, and the same auto-pause threshold as an agent run.

import { encryptSecret } from '@/lib/crypto';
import type { ForgeSupabase } from '@/lib/supabase';
import type {
  AgentRuntime,
  Build,
  BuildFile,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { nextRunFromCron } from '@/lib/engine/runtime/cron';
import { SystemSpecSchema, type SystemSpec } from '../spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '../planner/schema';

export interface SystemRuntimeContext {
  project: Project;
  build: Build;
  spec: SystemSpec;
  plan: OrchestrationPlan;
  files: BuildFile[];
}

// Loads the (project → latest kind='system' build → spec → plan →
// files) chain that the system runtime activation + tick path both
// need. Refuses any misroute (non-system spec/plan/build) with a
// clean 409.
export async function loadSystemRuntimeContext(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SystemRuntimeContext | { error: string; status: number }> {
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projErr || !project) return { error: 'project not found', status: 404 };

  // Peek at the latest build UNSCOPED so a software project landing
  // at the system runtime route gets a clear "use the software route"
  // 409 instead of a generic "no system build".
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
        "this is a software build (kind='software'). Use /api/projects/[id]/software/runtime/activate for the software go-live.",
      status: 409,
    };
  }
  if (latestAnyKind === 'agent') {
    return {
      error:
        "this is an agent build (kind='agent'). Use /api/projects/[id]/runtime/activate for the agent runtime.",
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

  // Activation requires 'deployed' (or 'running' for re-activation
  // when the runtime row was previously stopped — same shape as Phase
  // 1's runtime loader, which accepts 'pushed' or 'running').
  if (build.status !== 'deployed' && build.status !== 'running') {
    return {
      error:
        "system build is in status '" +
        build.status +
        "'; runtime requires 'deployed' or 'running'",
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

  const { data: files } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  const buildFiles = (files ?? []) as BuildFile[];
  if (buildFiles.length === 0) {
    return { error: 'system build has no files', status: 422 };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files: buildFiles,
  };
}

// Load the latest system runtime row for a project (kind='system').
// The Phase 1 loader doesn't filter by kind; the system path
// explicitly does so a project that's pivoted kinds can't show the
// wrong row.
export async function loadSystemRuntimeForProject(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<AgentRuntime | null> {
  const { data, error } = await supabase
    .from('agent_runtimes')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'system')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentRuntime | null) ?? null;
}

export interface CreateSystemRuntimeInput {
  project: Project;
  build: Build;
  mode: 'schedule' | 'always_on';
  scheduleCron: string;
  envValues: Record<string, string>;
  envKeys: string[];
  maxRunMs: number;
}

// Insert a kind='system' agent_runtimes row + flip the build status to
// 'running' (same convention as Phase 1's createRuntime — builds.status
// returns to 'deployed' / 'pushed' only when the runtime is fully
// stopped). The env is AES-256-GCM-encrypted before insert; plaintext
// never lands in any other column.
export async function createSystemRuntime(
  supabase: ForgeSupabase,
  input: CreateSystemRuntimeInput,
): Promise<AgentRuntime> {
  const env_encrypted =
    Object.keys(input.envValues).length > 0
      ? encryptSecret(JSON.stringify(input.envValues))
      : null;

  const next_run_at = nextRunFromCron(input.scheduleCron).toISOString();

  const { data, error } = await supabase
    .from('agent_runtimes')
    .insert({
      project_id: input.project.id,
      build_id: input.build.id,
      kind: 'system',
      mode: input.mode,
      schedule_cron: input.scheduleCron,
      status: 'active',
      next_run_at,
      env_encrypted,
      env_keys: input.envKeys,
      max_run_ms: input.maxRunMs,
      // Explicit zeros for the counters the per-run lifecycle reads +
      // increments. The real DB applies these as defaults; in-memory
      // test runners don't, so we set them here for robustness.
      run_count: 0,
      fail_count: 0,
      consecutive_fails: 0,
      last_run_at: null,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert system agent_runtime');
  }

  // Build moves to 'running' so the page header reflects an active
  // system. On stop, scheduler.setBuildStatusFromRuntime returns the
  // build to its pre-runtime state (for systems: 'deployed').
  await supabase
    .from('builds')
    .update({ status: 'running' })
    .eq('id', input.build.id);

  return data as AgentRuntime;
}

// When the runtime is stopped, the build returns to 'deployed' for
// systems (vs 'pushed' for agents). The shared scheduler helper
// `setBuildStatusFromRuntime` flips to 'pushed' regardless of kind —
// the system path uses this kind-aware variant instead.
export async function setSystemBuildStatusFromRuntime(
  supabase: ForgeSupabase,
  buildId: string,
  runtimeStatus: 'active' | 'paused' | 'stopped' | 'errored',
): Promise<void> {
  // Active / paused / errored all still represent a configured
  // runtime → build stays 'running'. Stopped reverts to 'deployed'
  // so the user can re-activate.
  const buildStatus = runtimeStatus === 'stopped' ? 'deployed' : 'running';
  await supabase
    .from('builds')
    .update({ status: buildStatus })
    .eq('id', buildId);
}
