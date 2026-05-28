// POST /api/projects/[id]/software/build/test
//
// Phase 3 (Software) sandbox — runs a generated software build in
// an isolated, disposable sandbox: install → next build → ephemeral
// pglite + the generated RLS migration → cross-user A/B isolation
// test. The isolation test is BUILD-FAILING — a structural RLS leak
// flips the build to 'test_failed' and does NOT trigger self-heal.
// Build-only failures DO trigger one bounded self-heal pass.
//
// REUSES the Phase 1 + 2 SandboxProvider + e2b BYOK + ledger
// machinery; only the build command (next build) and the isolation
// driver are software-specific.
//
// A software build STOPS after sandbox test in this phase: no DB
// provisioning / deploy / runtime exists for kind='software'. The
// Phase 1 + 2 sandbox routes 409 software builds; this route 409s
// non-software builds.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import {
  checkSoftwareSandboxConcurrency,
  insertRunningSoftwareSandboxRun,
  loadGeneratedSoftwareBuildForTest,
  logSoftwareSandboxOutcome,
  logSoftwareSandboxStarted,
  markSoftwareBuildTesting,
  markSoftwareSandboxRunCrashed,
  persistSoftwareRegeneratedFiles,
  persistSoftwareRunnerResult,
} from '@/lib/engine/software/sandbox/persistence';
import { runSoftwareSandbox } from '@/lib/engine/software/sandbox/runner';
import { auditEngineError } from '@/lib/engine/observability/audit-engine-error';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 600;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  // Sandbox budget. Software is heavier than agent (next build +
  // pglite install on top of the base sandbox lifetime).
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.15 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  const keyBail = await ensureBYOK(user.id, 'e2b');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();

  const guard = await loadGeneratedSoftwareBuildForTest(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { build, spec, plan, files } = guard;

  const conc = await checkSoftwareSandboxConcurrency(supabase, build.id);
  if ('error' in conc) {
    return NextResponse.json({ error: conc.error }, { status: conc.status });
  }

  const providerName = (process.env.SANDBOX_PROVIDER ?? 'e2b').toLowerCase();
  const run = await insertRunningSoftwareSandboxRun(supabase, build.id, providerName);

  // After this point we must reach EITHER persistSoftwareRunnerResult
  // OR markSoftwareSandboxRunCrashed — never leave a sandbox_run
  // stranded in 'running'.
  try {
    await logSoftwareSandboxStarted(supabase, build, run.id, providerName);
    await markSoftwareBuildTesting(supabase, build.id);

    const result = await runSoftwareSandbox({
      spec,
      plan,
      files,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'software.sandbox.test',
      },
    });

    // If self-heal regenerated a slot, persist the patched file
    // back into build_files BEFORE the run row's status flip.
    await persistSoftwareRegeneratedFiles(supabase, build.id, result);

    await persistSoftwareRunnerResult(supabase, { runId: run.id, build, result });
    await logSoftwareSandboxOutcome(supabase, build, run.id, result);

    return NextResponse.json({
      status: result.passed ? 'tested' : 'test_failed',
      kind: 'software',
      run_id: run.id,
      build_ok: result.build_ok,
      isolation_ok: result.isolation_ok,
      isolation: result.isolation,
      duration_ms: result.duration_ms,
      iterations: result.iterations,
      provider: result.provider,
      phases: result.phases.map((p) => ({
        phase: String(p.phase),
        status: p.status,
        timed_out: p.timed_out,
        iteration: p.iteration,
      })),
      selfheal_attempts: result.selfHealAttempts,
      error: result.error,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      await markSoftwareSandboxRunCrashed(supabase, run.id, build, 'needs E2B key');
      await supabase
        .from('builds')
        .update({ status: 'generated' })
        .eq('id', build.id);
      return needsKeyResponse(err)!;
    }
    await auditEngineError({
      supabase,
      projectId,
      action: 'software.sandbox_failed',
      err,
      actor: 'engine.software.sandbox',
      extra: { build_id: build.id, sandbox_run_id: run.id },
    });
    const message = err instanceof Error ? err.message : String(err);
    await markSoftwareSandboxRunCrashed(supabase, run.id, build, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
