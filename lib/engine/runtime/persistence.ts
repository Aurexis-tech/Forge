// DB helpers for the runtime layer. Server-only.

import { decryptSecret, encryptSecret } from '@/lib/crypto';
import type { ForgeSupabase } from '@/lib/supabase';
import type {
  AgentRun,
  AgentRunLogLine,
  AgentRunTrigger,
  AgentRuntime,
  Build,
  BuildFile,
  Json,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { BuildPlanSchema, type BuildPlan } from '../planner/schema';
import { AgentSpecSchema, type AgentSpec } from '../spec/schema';
import type { ExecutorResult } from './executor';
import { nextRunFromCron } from './cron';

export const AUTO_PAUSE_THRESHOLD = 3;

export interface RuntimeContext {
  project: Project;
  build: Build;
  spec: AgentSpec;
  plan: BuildPlan;
  files: BuildFile[];
}

// Loads everything the runtime layer needs and re-validates the stored
// spec + plan against current schemas. Returns a typed error envelope for
// the API routes to map straight to a response.
export async function loadRuntimeContext(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<RuntimeContext | { error: string; status: number }> {
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
    .order('created_at', { ascending: false })
    .limit(1);
  const build = (builds?.[0] as Build | undefined) ?? null;
  if (!build) return { error: 'project has no build', status: 409 };

  if (
    build.status !== 'pushed' &&
    build.status !== 'running'
  ) {
    return {
      error:
        "build is in status '" +
        build.status +
        "'; runtime requires 'pushed' or 'running'",
      status: 409,
    };
  }
  if (!build.spec_id || !build.plan_id) {
    return { error: 'build is missing spec_id or plan_id', status: 422 };
  }

  const { data: specRow } = await supabase
    .from('specs')
    .select('*')
    .eq('id', build.spec_id)
    .single();
  const spec = (specRow as Spec | null) ?? null;
  if (!spec) return { error: 'build references a missing spec', status: 422 };
  const parsedSpec = AgentSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return { error: 'stored AgentSpec no longer matches schema', status: 422 };
  }

  const { data: planRow } = await supabase
    .from('plans')
    .select('*')
    .eq('id', build.plan_id)
    .single();
  const plan = (planRow as Plan | null) ?? null;
  if (!plan) return { error: 'build references a missing plan', status: 422 };
  const parsedPlan = BuildPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return { error: 'stored BuildPlan no longer matches schema', status: 422 };
  }

  const { data: files } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  const buildFiles = (files ?? []) as BuildFile[];
  if (buildFiles.length === 0) {
    return { error: 'build has no files', status: 422 };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files: buildFiles,
  };
}

export async function loadRuntimeForProject(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<AgentRuntime | null> {
  const { data, error } = await supabase
    .from('agent_runtimes')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentRuntime | null) ?? null;
}

export async function loadRuntimeById(
  supabase: ForgeSupabase,
  runtimeId: string,
): Promise<AgentRuntime | null> {
  const { data, error } = await supabase
    .from('agent_runtimes')
    .select('*')
    .eq('id', runtimeId)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentRuntime | null) ?? null;
}

export async function loadRecentRuns(
  supabase: ForgeSupabase,
  runtimeId: string,
  limit = 10,
): Promise<AgentRun[]> {
  const { data, error } = await supabase
    .from('runs')
    .select('*')
    .eq('runtime_id', runtimeId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AgentRun[];
}

export interface CreateRuntimeInput {
  project: Project;
  build: Build;
  mode: 'schedule' | 'always_on';
  scheduleCron: string;
  envValues: Record<string, string>;
  envKeys: string[];
  maxRunMs: number;
}

export async function createRuntime(
  supabase: ForgeSupabase,
  input: CreateRuntimeInput,
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
      mode: input.mode,
      schedule_cron: input.scheduleCron,
      status: 'active',
      next_run_at,
      env_encrypted,
      env_keys: input.envKeys,
      max_run_ms: input.maxRunMs,
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('failed to insert agent_runtime');

  await supabase
    .from('builds')
    .update({ status: 'running' })
    .eq('id', input.build.id);

  return data as AgentRuntime;
}

export async function setRuntimeStatus(
  supabase: ForgeSupabase,
  runtimeId: string,
  status: 'active' | 'paused' | 'stopped' | 'errored',
  extras: { next_run_at?: string | null; consecutive_fails?: number } = {},
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (extras.next_run_at !== undefined) update.next_run_at = extras.next_run_at;
  if (extras.consecutive_fails !== undefined) {
    update.consecutive_fails = extras.consecutive_fails;
  }
  const { error } = await supabase
    .from('agent_runtimes')
    .update(update)
    .eq('id', runtimeId);
  if (error) throw error;
}

export async function setBuildStatusFromRuntime(
  supabase: ForgeSupabase,
  buildId: string,
  runtimeStatus: 'active' | 'paused' | 'stopped' | 'errored',
): Promise<void> {
  // Build returns to 'pushed' only when the runtime is fully stopped.
  // Active / paused / errored all still represent a configured runtime.
  const buildStatus = runtimeStatus === 'stopped' ? 'pushed' : 'running';
  await supabase
    .from('builds')
    .update({ status: buildStatus })
    .eq('id', buildId);
}

// --- Runs ------------------------------------------------------------------

export async function insertRunningRunRow(
  supabase: ForgeSupabase,
  runtimeId: string,
  trigger: AgentRunTrigger,
): Promise<AgentRun> {
  const { data, error } = await supabase
    .from('runs')
    .insert({
      runtime_id: runtimeId,
      trigger,
      status: 'running',
      logs: [] as unknown as Json,
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('failed to insert run');
  return data as AgentRun;
}

export interface FinishRunInput {
  runtime: AgentRuntime;
  runId: string;
  result: ExecutorResult;
  scheduleNextTick: boolean;
}

export async function finishRunRow(
  supabase: ForgeSupabase,
  input: FinishRunInput,
): Promise<{ autoPaused: boolean }> {
  const finishedAt = new Date();
  const status: 'succeeded' | 'failed' = input.result.success
    ? 'succeeded'
    : 'failed';

  const { error: runErr } = await supabase
    .from('runs')
    .update({
      status,
      finished_at: finishedAt.toISOString(),
      duration_ms: input.result.duration_ms,
      logs: input.result.logs as unknown as Json,
      output: (input.result.output ?? null) as Json,
      error: input.result.error,
    })
    .eq('id', input.runId);
  if (runErr) throw runErr;

  const consecutiveFails = input.result.success
    ? 0
    : input.runtime.consecutive_fails + 1;
  const shouldAutoPause = !input.result.success && consecutiveFails >= AUTO_PAUSE_THRESHOLD;

  const update: Record<string, unknown> = {
    last_run_at: finishedAt.toISOString(),
    run_count: input.runtime.run_count + 1,
    fail_count: input.runtime.fail_count + (input.result.success ? 0 : 1),
    consecutive_fails: consecutiveFails,
  };

  if (shouldAutoPause) {
    update.status = 'errored';
    update.next_run_at = null;
  } else if (input.scheduleNextTick && input.runtime.status === 'active') {
    update.next_run_at = nextRunFromCron(
      input.runtime.schedule_cron,
      finishedAt,
    ).toISOString();
  }

  const { error: rtErr } = await supabase
    .from('agent_runtimes')
    .update(update)
    .eq('id', input.runtime.id);
  if (rtErr) throw rtErr;

  return { autoPaused: shouldAutoPause };
}

export function decryptRuntimeEnv(
  runtime: AgentRuntime,
): Record<string, string> {
  if (!runtime.env_encrypted) return {};
  const json = decryptSecret(runtime.env_encrypted);
  const parsed = JSON.parse(json);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  return {};
}

// --- Audit -----------------------------------------------------------------

export async function audit(
  supabase: ForgeSupabase,
  args: {
    projectId: string | null;
    action: string;
    actor: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: args.action,
    actor: args.actor,
    detail: args.detail as Json,
  });
}

export function publicLogLines(logs: Json | null | undefined): AgentRunLogLine[] {
  if (!logs || !Array.isArray(logs)) return [];
  return (logs as unknown as AgentRunLogLine[]).filter(
    (l) => l && typeof l.message === 'string',
  );
}
