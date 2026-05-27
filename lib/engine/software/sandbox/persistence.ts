// DB helpers for the Phase 3 (Software) sandbox harness. Same shape
// as lib/engine/system/sandbox/persistence.ts; both write into the
// SAME `sandbox_runs` table. A sandbox_run's "kind" is derivable
// through `builds.kind` — no extra discriminator column.
//
// IMPORTANT: a software build STOPS after sandbox test in this
// phase. There's no DB provisioning / deploy / runtime path for
// kind='software'. The Phase 1 + 2 sandbox loaders refuse a
// software build with 409 + the new-route hint, and the loader
// below refuses anything that isn't kind='software' at
// status='generated'.

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
import { SoftwareSpecSchema, type SoftwareSpec } from '../spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '../planner/schema';
import type {
  SoftwarePhaseSummary,
  SoftwareRunnerResult,
} from './runner';

export interface SoftwareSandboxTestContext {
  project: Project;
  build: Build;
  spec: SoftwareSpec;
  plan: SoftwareBuildPlan;
  files: BuildFile[];
}

export async function loadGeneratedSoftwareBuildForTest(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<SoftwareSandboxTestContext | { error: string; status: number }> {
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
  if (build.status !== 'generated') {
    return {
      error:
        "software build is in status '" +
        build.status +
        "'; only 'generated' can be tested",
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
        "build references a non-software spec (kind='" +
        spec.kind +
        "'); use the agent / system sandbox path",
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
      error:
        "build references a non-software plan (kind='" + plan.kind + "')",
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

  const { data: files } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  const buildFiles = (files ?? []) as BuildFile[];
  if (buildFiles.length === 0) {
    return { error: 'software build has no files', status: 422 };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files: buildFiles,
  };
}

// Same concurrency rule as Phases 1 + 2 — one running sandbox_run
// per build at a time; zombies older than 15 min are reaped.
export async function checkSoftwareSandboxConcurrency(
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
        'a sandbox test is already running for this software build (run ' +
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

export async function insertRunningSoftwareSandboxRun(
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
    throw error ?? new Error('failed to insert software sandbox_run');
  }
  return data as SandboxRun;
}

export async function markSoftwareBuildTesting(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase.from('builds').update({ status: 'testing' }).eq('id', buildId);
}

// The sandbox_runs.logs payload carries phases + lines + the
// isolation result + any self-heal attempts so the UI can render
// the full trail without re-running anything.
interface SoftwareSandboxLogsPayload {
  phases: SoftwarePhaseSummary[];
  lines: SandboxLogLine[];
  isolation: SoftwareRunnerResult['isolation'];
  selfheal_attempts: SoftwareRunnerResult['selfHealAttempts'];
}

export async function persistSoftwareRunnerResult(
  supabase: ForgeSupabase,
  args: {
    runId: string;
    build: Build;
    result: SoftwareRunnerResult;
  },
): Promise<void> {
  const status: SandboxRun['status'] = args.result.passed ? 'passed' : 'failed';
  const buildStatus = args.result.passed ? 'tested' : 'test_failed';

  const logsPayload: SoftwareSandboxLogsPayload = {
    phases: args.result.phases,
    lines: args.result.logs,
    isolation: args.result.isolation,
    selfheal_attempts: args.result.selfHealAttempts,
  };

  const { error: runErr } = await supabase
    .from('sandbox_runs')
    .update({
      status,
      build_ok: args.result.build_ok,
      // `smoke_ok` column repurposed: the software sandbox uses it
      // for the ISOLATION outcome so the row's shape stays compatible
      // with the existing agent / system rows the UI knows how to
      // render.
      smoke_ok: args.result.isolation_ok,
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

// Persist any LLM-regenerated slot file from the bounded self-heal
// back to build_files so the stored project matches what the
// sandbox actually tested.
export async function persistSoftwareRegeneratedFiles(
  supabase: ForgeSupabase,
  buildId: string,
  result: SoftwareRunnerResult,
): Promise<void> {
  if (result.selfHealAttempts.length === 0) return;
  const patchedPaths = new Set(
    result.selfHealAttempts.map((a) => a.file_path),
  );
  const newFiles = result.files.filter((f) => patchedPaths.has(f.path));
  if (newFiles.length === 0) return;

  for (const f of newFiles) {
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

export async function logSoftwareSandboxStarted(
  supabase: ForgeSupabase,
  build: Build,
  runId: string,
  provider: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.sandbox_started',
    actor: 'engine.software.sandbox',
    detail: { build_id: build.id, run_id: runId, provider },
  });
}

export async function logSoftwareSandboxOutcome(
  supabase: ForgeSupabase,
  build: Build,
  runId: string,
  result: SoftwareRunnerResult,
): Promise<void> {
  // One selfheal_attempted row per attempt — emitted regardless of
  // the final outcome so ops can see a retry happened.
  for (const attempt of result.selfHealAttempts) {
    await supabase.from('audit_log').insert({
      project_id: build.project_id,
      action: 'software.selfheal_attempted',
      actor: 'engine.software.sandbox',
      detail: {
        build_id: build.id,
        run_id: runId,
        file_path: attempt.file_path,
        slot_regen_ok: attempt.slot_regen_ok,
        build_ok_after_retry: attempt.build_ok_after_retry,
        isolation_ok_after_retry: attempt.isolation_ok_after_retry,
      },
    });
  }

  // Isolation failures get their OWN audit row before the generic
  // sandbox_failed, so a downstream observer can distinguish a
  // structural RLS leak from a generic build / install failure.
  if (
    result.build_ok &&
    !result.isolation_ok &&
    result.isolation &&
    result.isolation.outcome === 'failed'
  ) {
    await supabase.from('audit_log').insert({
      project_id: build.project_id,
      action: 'software.isolation_failed',
      actor: 'engine.software.sandbox',
      detail: {
        build_id: build.id,
        run_id: runId,
        leak_table: result.isolation.leakTable,
        leak_count: result.isolation.leakCount,
        per_entity: result.isolation.perEntity,
        reason: result.isolation.errorMessage,
      },
    });
  }

  if (result.passed) {
    await supabase.from('audit_log').insert({
      project_id: build.project_id,
      action: 'software.sandbox_passed',
      actor: 'engine.software.sandbox',
      detail: {
        build_id: build.id,
        run_id: runId,
        provider: result.provider,
        duration_ms: result.duration_ms,
        iterations: result.iterations,
        isolation: result.isolation
          ? {
              outcome: result.isolation.outcome,
              vacuous: result.isolation.vacuous,
              per_entity: result.isolation.perEntity,
            }
          : null,
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
    action: 'software.sandbox_failed',
    actor: 'engine.software.sandbox',
    detail: {
      build_id: build.id,
      run_id: runId,
      provider: result.provider,
      duration_ms: result.duration_ms,
      iterations: result.iterations,
      failing_phase: failingPhase?.phase ?? 'unknown',
      isolation_outcome: result.isolation?.outcome ?? null,
      error: result.error,
      phases: phasesSummary(result.phases),
    },
  });
}

function phasesSummary(
  phases: SoftwarePhaseSummary[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of phases) {
    out[String(p.phase) + '@' + String(p.iteration)] = p.status;
  }
  return out;
}

export async function markSoftwareSandboxRunCrashed(
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
    action: 'software.sandbox_failed',
    actor: 'engine.software.sandbox',
    detail: { build_id: build.id, run_id: runId, error: message, crashed: true },
  });
}

export async function loadLatestSoftwareSandboxRun(
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
