import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import { CodegenError, generateCode } from '@/lib/engine/codegen/generate';
import {
  completeCodegen,
  insertCodegenBuild,
  loadApprovedPlanForCodegen,
  logCodegenStarted,
  markBuildFailed,
  markBuildGenerating,
  storeBuildFiles,
} from '@/lib/engine/codegen/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface RouteContext {
  params: { id: string };
}

// Regenerate ALWAYS inserts a fresh builds row, even if a previous build is
// already in 'generated' or further. The latest build wins in the UI; older
// builds remain in the database for audit.
export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.5 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  // Pre-flight key gate — bail with 412 if Anthropic isn't connected.
  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();

  const guard = await loadApprovedPlanForCodegen(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { plan, spec, parsedPlan, parsedSpec } = guard;

  const build = await insertCodegenBuild(supabase, projectId, plan.id, spec.id);

  try {
    await logCodegenStarted(supabase, build);
    await markBuildGenerating(supabase, build.id);

    const summary = await generateCode({
      spec: parsedSpec,
      plan: parsedPlan,
      governance: { user_id: user.id, project_id: projectId, ref: 'codegen.regenerate' },
    });

    await storeBuildFiles(supabase, build.id, summary.files);
    await completeCodegen(supabase, build, summary);

    return NextResponse.json({
      status: 'generated',
      build_id: build.id,
      files_total: summary.files.length,
      scaffold_count: summary.files.filter((f) => f.source === 'scaffold').length,
      generated_count: summary.files.filter((f) => f.source === 'generated').length,
      warnings: summary.warnings,
      llm_files_failed: summary.llmFilesFailed,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Reset the freshly-inserted build to pending so the user can retry
      // after connecting their key — keeps the audit trail honest.
      await supabase
        .from('builds')
        .update({ status: 'pending' })
        .eq('id', build.id);
      return needsKeyResponse(err)!;
    }
    const message = describeError(err);
    await markBuildFailed(supabase, build.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function describeError(err: unknown): string {
  if (err instanceof CodegenError) return err.message;
  if (err instanceof LLMError) return 'LLM error: ' + err.message;
  if (err instanceof Error) return err.message;
  return 'unknown codegen error';
}
