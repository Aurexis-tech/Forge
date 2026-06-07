import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import {
  checkConcurrency,
  insertRunningSandboxRun,
  loadGeneratedBuildForTest,
  logTestOutcome,
  logTestStarted,
  markBuildTesting,
  markRunCrashed,
  persistRunnerResult,
} from '@/lib/engine/sandbox/persistence';
import { runSandbox } from '@/lib/engine/sandbox/runner';
import { auditEngineError } from '@/lib/engine/observability/audit-engine-error';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  // Sandbox compute is bounded by SANDBOX_LIFETIME_MS (6 min) so the worst
  // case sits comfortably under a cent at default rates.
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.05 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  // Pre-flight key gate — bail with 412 if E2B isn't connected.
  // The sandbox provider is E2B by default; we gate on the provider used
  // for the actual sandbox call. If SANDBOX_PROVIDER is overridden to a
  // non-E2B provider later, this check should be widened.
  const keyBail = await ensureBYOK(user.id, 'e2b');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();

  const guard = await loadGeneratedBuildForTest(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { build, spec, plan, files } = guard;

  const conc = await checkConcurrency(supabase, build.id);
  if ('error' in conc) {
    return NextResponse.json({ error: conc.error }, { status: conc.status });
  }

  const providerName = (process.env.SANDBOX_PROVIDER ?? 'e2b').toLowerCase();
  const run = await insertRunningSandboxRun(supabase, build.id, providerName);

  // After this point we must reach EITHER persistRunnerResult OR markRunCrashed
  // — never leave a sandbox_run stranded in 'running'.
  try {
    await logTestStarted(supabase, build, run.id, providerName);
    await markBuildTesting(supabase, build.id);

    const result = await runSandbox({
      spec,
      plan,
      files,
      governance: { user_id: user.id, project_id: projectId, ref: 'sandbox.test' },
    });

    await persistRunnerResult(supabase, { runId: run.id, build, result });
    await logTestOutcome(supabase, build, run.id, result);

    return NextResponse.json({
      status: result.passed ? 'tested' : 'test_failed',
      run_id: run.id,
      build_ok: result.build_ok,
      smoke_ok: result.smoke_ok,
      duration_ms: result.duration_ms,
      provider: result.provider,
      phases: result.phases.map((p) => ({
        phase: p.phase,
        status: p.status,
        timed_out: p.timed_out,
      })),
      error: result.error,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Don't mark the run "crashed" — nothing technically failed; the
      // sandbox key just wasn't connected. Mark the run aborted and
      // revert the build to 'generated' so the user can retry.
      const message = 'needs E2B key';
      await markRunCrashed(supabase, run.id, build, message);
      await supabase
        .from('builds')
        .update({ status: 'generated' })
        .eq('id', build.id);
      return needsKeyResponse(err)!;
    }
    // Thread the EngineError category / code / userMessage into
    // the audit trail so the Forge timeline distinguishes a
    // transient sandbox blip from a real bug.
    await auditEngineError({
      supabase,
      projectId,
      action: 'sandbox.run_failed',
      err,
      actor: 'engine.sandbox',
      extra: { build_id: build.id, sandbox_run_id: run.id },
    });
    const message = err instanceof Error ? err.message : String(err);
    await markRunCrashed(supabase, run.id, build, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
