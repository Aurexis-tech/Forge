// DB helpers for the sandbox layer. Server-only.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  Plan,
  Project,
  SandboxLogLine,
  SandboxRun,
  Spec,
} from '@/lib/types';
import { AgentSpecSchema, type AgentSpec } from '../spec/schema';
import { BuildPlanSchema, type BuildPlan } from '../planner/schema';
import type { PhaseSummary, RunnerResult } from './runner';

export interface SandboxTestContext {
  project: Project;
  build: Build;
  spec: AgentSpec;
  plan: BuildPlan;
  files: BuildFile[];
}

export async function loadGeneratedBuildForTest(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SandboxTestContext | { error: string; status: number }> {
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
  if (build.status !== 'generated') {
    return {
      error:
        "build is in status '" +
        build.status +
        "'; only 'generated' can be tested",
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
    return {
      error: 'stored AgentSpec no longer matches the current schema',
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
  const parsedPlan = BuildPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return {
      error: 'stored BuildPlan no longer matches the current schema',
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

// Concurrency gate: refuse to start a second sandbox run while one for this
// build is already 'running'. Older 'running' rows (>15 minutes) are treated
// as zombies and ignored so a crashed run doesn't lock the build forever.
export async function checkConcurrency(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const { data } = await supabase
    .from('sandbox_runs')
    .select('id, status, created_at')
    .eq('build_id', buildId)
    .eq('status', 'running')
    .order('created_at', { ascending: false })
    .limit(1);
  const latest = data?.[0] as { id: string; status: string; created_at: string } | undefined;
  if (!latest) return { ok: true };
  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  if (ageMs < 15 * 60_000) {
    return {
      error:
        'a sandbox test is already running for this build (run ' +
        latest.id.slice(0, 8) +
        ')',
      status: 409,
    };
  }
  // Mark the zombie as failed before allowing a fresh run.
  await supabase
    .from('sandbox_runs')
    .update({ status: 'failed', error: 'zombie run reaped' })
    .eq('id', latest.id);
  return { ok: true };
}

export async function insertRunningSandboxRun(
  supabase: ForgeSupabase,
  buildId: string,
  provider: string,
): Promise<SandboxRun> {
  const { data, error } = await supabase
    .from('sandbox_runs')
    .insert({
      build_id: buildId,
      provider,
      status: 'running',
      logs: [] as unknown as SandboxRun['logs'],
      iterations: 0,
      build_ok: null,
      smoke_ok: null,
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('failed to insert sandbox_run');
  return data as SandboxRun;
}

export async function markBuildTesting(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase.from('builds').update({ status: 'testing' }).eq('id', buildId);
}

export async function persistRunnerResult(
  supabase: ForgeSupabase,
  args: {
    runId: string;
    build: Build;
    result: RunnerResult;
  },
): Promise<void> {
  const status: SandboxRun['status'] = args.result.passed ? 'passed' : 'failed';
  const buildStatus = args.result.passed ? 'tested' : 'test_failed';

  // Store the runner's structured logs alongside a phase summary so the UI
  // can show the three phases without re-parsing the line list.
  const logsPayload = {
    phases: args.result.phases,
    lines: args.result.logs,
  };

  const { error: runErr } = await supabase
    .from('sandbox_runs')
    .update({
      status,
      build_ok: args.result.build_ok,
      smoke_ok: args.result.smoke_ok,
      logs: logsPayload as unknown as SandboxRun['logs'],
      error: args.result.error,
      duration_ms: args.result.duration_ms,
      iterations: args.result.iterations,
    })
    .eq('id', args.runId);
  if (runErr) throw runErr;

  const { error: buildErr } = await supabase
    .from('builds')
    .update({ status: buildStatus })
    .eq('id', args.build.id);
  if (buildErr) throw buildErr;
}

export async function logTestStarted(
  supabase: ForgeSupabase,
  build: Build,
  runId: string,
  provider: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'build.test_started',
    actor: 'engine.sandbox',
    detail: { build_id: build.id, run_id: runId, provider },
  });
}

export async function logTestOutcome(
  supabase: ForgeSupabase,
  build: Build,
  runId: string,
  result: RunnerResult,
): Promise<void> {
  if (result.passed) {
    await supabase.from('audit_log').insert({
      project_id: build.project_id,
      action: 'build.test_passed',
      actor: 'engine.sandbox',
      detail: {
        build_id: build.id,
        run_id: runId,
        provider: result.provider,
        duration_ms: result.duration_ms,
        iterations: result.iterations,
        phases: phasesSummary(result.phases),
      },
    });
    return;
  }

  const failingPhase = result.phases.find((p) => p.status === 'failed');
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'build.test_failed',
    actor: 'engine.sandbox',
    detail: {
      build_id: build.id,
      run_id: runId,
      provider: result.provider,
      duration_ms: result.duration_ms,
      iterations: result.iterations,
      failing_phase: failingPhase?.phase ?? 'unknown',
      error: result.error,
      phases: phasesSummary(result.phases),
    },
  });
}

function phasesSummary(phases: PhaseSummary[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of phases) out[p.phase] = p.status;
  return out;
}

export async function markRunCrashed(
  supabase: ForgeSupabase,
  runId: string,
  build: Build,
  message: string,
): Promise<void> {
  await supabase
    .from('sandbox_runs')
    .update({ status: 'failed', error: message })
    .eq('id', runId);
  await supabase
    .from('builds')
    .update({ status: 'test_failed' })
    .eq('id', build.id);
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'build.test_failed',
    actor: 'engine.sandbox',
    detail: { build_id: build.id, run_id: runId, error: message, crashed: true },
  });
}

export async function loadLatestSandboxRun(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<SandboxRun | null> {
  const { data, error } = await supabase
    .from('sandbox_runs')
    .select('*')
    .eq('build_id', buildId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as SandboxRun | null) ?? null;
}

// Re-export the line type for UI consumers that want to render lines from
// a stored sandbox_run.
export type { SandboxLogLine };
