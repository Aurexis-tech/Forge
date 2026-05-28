// POST /api/projects/[id]/system/build/test
//
// Phase 2 (Systems) sandbox — runs a generated system build in an
// isolated, disposable sandbox as a smoke test. Reuses the Phase 1
// SandboxProvider + e2b BYOK + ledger machinery; only the smoke
// driver and the kind-discriminated persistence are system-specific.
//
// A system build STOPS after sandbox test in this phase: no deploy
// or runtime path exists for kind='system'. The Phase 1 sandbox
// route 409s system builds; this route 409s non-system builds.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import {
  checkSystemConcurrency,
  insertRunningSystemSandboxRun,
  loadGeneratedSystemBuildForTest,
  logSystemSandboxOutcome,
  logSystemSandboxStarted,
  markSystemBuildTesting,
  markSystemRunCrashed,
  persistRegeneratedModuleFiles,
  persistSystemRunnerResult,
} from '@/lib/engine/system/sandbox/persistence';
import { runSystemSandbox } from '@/lib/engine/system/sandbox/runner';
import { auditEngineError } from '@/lib/engine/observability/audit-engine-error';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// Same ceiling as the Phase 1 sandbox route. Self-heal adds at most
// one extra build+smoke pass, still inside SANDBOX_LIFETIME_MS.
export const maxDuration = 600;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  // Same budget gate posture as Phase 1 sandbox — bounded by the 6-min
  // sandbox lifetime. Self-heal may add one extra LLM round but that's
  // gated separately by the per-call governance guard.
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.1 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  // Pre-flight key gate — bail with 412 if E2B isn't connected.
  const keyBail = await ensureBYOK(user.id, 'e2b');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();

  const guard = await loadGeneratedSystemBuildForTest(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { build, spec, plan, files } = guard;

  const conc = await checkSystemConcurrency(supabase, build.id);
  if ('error' in conc) {
    return NextResponse.json({ error: conc.error }, { status: conc.status });
  }

  const providerName = (process.env.SANDBOX_PROVIDER ?? 'e2b').toLowerCase();
  const run = await insertRunningSystemSandboxRun(supabase, build.id, providerName);

  // After this point we must reach EITHER persistSystemRunnerResult OR
  // markSystemRunCrashed — never leave a sandbox_run stranded in
  // 'running'.
  try {
    await logSystemSandboxStarted(supabase, build, run.id, providerName);
    await markSystemBuildTesting(supabase, build.id);

    const result = await runSystemSandbox({
      spec,
      plan,
      files,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'system.sandbox.test',
      },
    });

    // If self-heal regenerated a module, persist the patched file
    // back into build_files BEFORE the run row's status flip so a
    // post-test re-read of the build shows what the sandbox tested.
    await persistRegeneratedModuleFiles(supabase, build.id, result);

    await persistSystemRunnerResult(supabase, { runId: run.id, build, result });
    await logSystemSandboxOutcome(supabase, build, run.id, result);

    return NextResponse.json({
      status: result.passed ? 'tested' : 'test_failed',
      kind: 'system',
      run_id: run.id,
      build_ok: result.build_ok,
      smoke_ok: result.smoke_ok,
      duration_ms: result.duration_ms,
      iterations: result.iterations,
      provider: result.provider,
      phases: result.phases.map((p) => ({
        phase: p.phase,
        status: p.status,
        timed_out: p.timed_out,
        iteration: p.iteration,
      })),
      selfheal_attempts: result.selfHealAttempts,
      error: result.error,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Don't mark crashed — nothing technically failed; the sandbox
      // key just wasn't connected. Mark the run aborted + revert
      // build back to 'generated' so the user can retry.
      await markSystemRunCrashed(supabase, run.id, build, 'needs E2B key');
      await supabase
        .from('builds')
        .update({ status: 'generated' })
        .eq('id', build.id);
      return needsKeyResponse(err)!;
    }
    await auditEngineError({
      supabase,
      projectId,
      action: 'system.sandbox_failed',
      err,
      actor: 'engine.system.sandbox',
      extra: { build_id: build.id, sandbox_run_id: run.id },
    });
    const message = err instanceof Error ? err.message : String(err);
    await markSystemRunCrashed(supabase, run.id, build, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
