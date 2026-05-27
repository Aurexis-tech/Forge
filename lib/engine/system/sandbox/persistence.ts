// DB helpers for the Phase 2 (Systems) sandbox harness. Same shape as
// lib/engine/sandbox/persistence.ts; both write into the SAME
// `sandbox_runs` table. A sandbox_run's "kind" is derivable through
// `builds.kind` (extended in 0018_system_builds.sql) — no extra
// discriminator column is needed.
//
// IMPORTANT: a system build STOPS after sandbox test in this phase.
// There's no system deploy or system runtime path. The Phase 1
// sandbox loader (`loadGeneratedBuildForTest`) refuses non-agent
// builds with 409 as defence in depth, and the loader below refuses
// anything that isn't a kind='system' build at status='generated'.

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
import { SystemSpecSchema, type SystemSpec } from '../spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '../planner/schema';
import type {
  SystemPhaseSummary,
  SystemRunnerResult,
} from './runner';

export interface SystemSandboxTestContext {
  project: Project;
  build: Build;
  spec: SystemSpec;
  plan: OrchestrationPlan;
  files: BuildFile[];
}

// Mirror of the Phase 1 loader. Walks the (project → latest build →
// spec → plan → build_files) chain and refuses any misroute with a
// clear 409. The build MUST be kind='system' and status='generated'.
export async function loadGeneratedSystemBuildForTest(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SystemSandboxTestContext | { error: string; status: number }> {
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
    .eq('kind', 'system')
    .order('created_at', { ascending: false })
    .limit(1);
  const build = (builds?.[0] as Build | undefined) ?? null;
  if (!build) return { error: 'project has no system build', status: 409 };
  if (build.status !== 'generated') {
    return {
      error:
        "system build is in status '" +
        build.status +
        "'; only 'generated' can be tested",
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
        "build references a non-system spec (kind='" +
        spec.kind +
        "'); use the agent sandbox path instead",
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
      error:
        "build references a non-system plan (kind='" +
        plan.kind +
        "')",
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

// Same concurrency rule as Phase 1 — at most one 'running' sandbox_run
// per build at a time; zombies older than 15 min are reaped.
export async function checkSystemConcurrency(
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
  const latest = data?.[0] as
    | { id: string; status: string; created_at: string }
    | undefined;
  if (!latest) return { ok: true };
  const ageMs = Date.now() - new Date(latest.created_at).getTime();
  if (ageMs < 15 * 60_000) {
    return {
      error:
        'a sandbox test is already running for this system build (run ' +
        latest.id.slice(0, 8) +
        ')',
      status: 409,
    };
  }
  await supabase
    .from('sandbox_runs')
    .update({ status: 'failed', error: 'zombie run reaped' })
    .eq('id', latest.id);
  return { ok: true };
}

export async function insertRunningSystemSandboxRun(
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
  if (error || !data) {
    throw error ?? new Error('failed to insert system sandbox_run');
  }
  return data as SandboxRun;
}

export async function markSystemBuildTesting(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase.from('builds').update({ status: 'testing' }).eq('id', buildId);
}

interface SystemSandboxLogsPayload {
  phases: SystemPhaseSummary[];
  lines: SandboxLogLine[];
  // Self-heal trail — empty when no retry was attempted. Kept inside
  // logs (jsonb) rather than spawning a new column so the existing
  // sandbox_runs schema is unchanged.
  selfheal_attempts: SystemRunnerResult['selfHealAttempts'];
}

export async function persistSystemRunnerResult(
  supabase: ForgeSupabase,
  args: {
    runId: string;
    build: Build;
    result: SystemRunnerResult;
  },
): Promise<void> {
  const status: SandboxRun['status'] = args.result.passed ? 'passed' : 'failed';
  const buildStatus = args.result.passed ? 'tested' : 'test_failed';

  const logsPayload: SystemSandboxLogsPayload = {
    phases: args.result.phases,
    lines: args.result.logs,
    selfheal_attempts: args.result.selfHealAttempts,
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

// If the runner regenerated any module, persist the patched file(s)
// back into build_files so the stored project matches what the
// sandbox actually tested. Files whose contents are unchanged are
// left alone (we match on path; an upsert keeps the row identity
// stable and survives a UNIQUE(build_id, path) constraint).
export async function persistRegeneratedModuleFiles(
  supabase: ForgeSupabase,
  buildId: string,
  result: SystemRunnerResult,
): Promise<void> {
  if (result.selfHealAttempts.length === 0) return;
  const regeneratedPaths = new Set(
    result.selfHealAttempts.map((a) => 'src/modules/' + a.node_id + '/index.ts'),
  );
  const newFiles = result.files.filter((f) => regeneratedPaths.has(f.path));
  if (newFiles.length === 0) return;

  for (const f of newFiles) {
    // Delete-then-insert keeps the existing UNIQUE(build_id, path)
    // constraint honest without depending on the supabase client
    // implementing onConflict the same way across runtimes.
    await supabase
      .from('build_files')
      .delete()
      .eq('build_id', buildId)
      .eq('path', f.path);
    const { error } = await supabase.from('build_files').insert({
      build_id: buildId,
      path: f.path,
      content: f.content,
      source: f.source,
      bytes: f.bytes,
    });
    if (error) throw error;
  }
}

export async function logSystemSandboxStarted(
  supabase: ForgeSupabase,
  build: Build,
  runId: string,
  provider: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.sandbox_started',
    actor: 'engine.system.sandbox',
    detail: { build_id: build.id, run_id: runId, provider },
  });
}

export async function logSystemSandboxOutcome(
  supabase: ForgeSupabase,
  build: Build,
  runId: string,
  result: SystemRunnerResult,
): Promise<void> {
  // Always emit one selfheal_attempted row per attempt, regardless of
  // pass/fail downstream — the brief calls this out explicitly so
  // ops can see a retry happened.
  for (const attempt of result.selfHealAttempts) {
    await supabase.from('audit_log').insert({
      project_id: build.project_id,
      action: 'system.selfheal_attempted',
      actor: 'engine.system.sandbox',
      detail: {
        build_id: build.id,
        run_id: runId,
        node_id: attempt.node_id,
        module_regen_ok: attempt.module_regen_ok,
        smoke_ok_after_retry: attempt.smoke_ok_after_retry,
      },
    });
  }

  if (result.passed) {
    await supabase.from('audit_log').insert({
      project_id: build.project_id,
      action: 'system.sandbox_passed',
      actor: 'engine.system.sandbox',
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

  const failingPhase = result.phases
    .filter((p) => p.iteration === result.iterations)
    .find((p) => p.status === 'failed');
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.sandbox_failed',
    actor: 'engine.system.sandbox',
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

function phasesSummary(phases: SystemPhaseSummary[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of phases) {
    // Iteration-aware key so the audit log shows the full trail
    // when self-heal fires (build@0=ok, smoke@0=failed, build@1=ok,
    // smoke@1=ok).
    out[p.phase + '@' + String(p.iteration)] = p.status;
  }
  return out;
}

export async function markSystemRunCrashed(
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
    action: 'system.sandbox_failed',
    actor: 'engine.system.sandbox',
    detail: { build_id: build.id, run_id: runId, error: message, crashed: true },
  });
}

export async function loadLatestSystemSandboxRun(
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
