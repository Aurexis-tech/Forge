// POST /api/projects/[id]/system/build/generate
//
// Phase 2 (Systems) codegen — turns an approved OrchestrationPlan into
// an orchestrator + per-module agent project. The per-node module
// generator REUSES the Phase 1 agent codegen (lib/engine/codegen/
// generate.ts → generateOneAgentFile); the orchestrator is deterministic
// (lib/engine/system/codegen/orchestrator.ts).
//
// A system build STOPS after codegen — there's no system sandbox /
// deploy / runtime path in this prompt. The Phase 1 codegen route 409s
// non-agent kinds; this route 409s anything that isn't a confirmed-
// system spec + approved-system plan.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import {
  generateSystemCode,
  SystemCodegenError,
} from '@/lib/engine/system/codegen/generate';
import {
  completeSystemCodegen,
  ensureSystemCodegenBuild,
  loadApprovedSystemPlanForCodegen,
  logSystemCodegenStarted,
  markSystemBuildFailed,
  markSystemBuildGenerating,
  storeSystemBuildFiles,
} from '@/lib/engine/system/codegen/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// Per-node generation is sequential and each call is 1-2 LLM rounds; a
// 3-node pipeline finishes well under a minute. 300s matches the Phase
// 1 codegen ceiling so we don't surprise anyone with a tighter cap.
export const maxDuration = 300;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  // Per-node LLM calls each go through their own assertAllowed via
  // lib/engine/llm.complete(); this route-level pre-flight is just a
  // cheap fast-fail when the project's already over budget. Budget
  // estimate covers ~5 modules × ~0.05 USD/module.
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.3 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  // Pre-flight key gate — bail with 412 if Anthropic isn't connected.
  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();

  const guard = await loadApprovedSystemPlanForCodegen(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { plan, spec, parsedPlan, parsedSpec } = guard;

  const buildResult = await ensureSystemCodegenBuild(
    supabase,
    projectId,
    plan.id,
    spec.id,
  );
  if ('error' in buildResult) {
    return NextResponse.json(
      { error: buildResult.error },
      { status: buildResult.status },
    );
  }
  const build = buildResult.build;

  try {
    await logSystemCodegenStarted(supabase, build);
    await markSystemBuildGenerating(supabase, build.id);

    const summary = await generateSystemCode({
      spec: parsedSpec,
      plan: parsedPlan,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'system.codegen.generate.' + build.id,
      },
    });

    await storeSystemBuildFiles(supabase, build.id, summary);
    await completeSystemCodegen(supabase, build, summary);

    return NextResponse.json({
      status: 'generated',
      kind: 'system',
      build_id: build.id,
      files_total: summary.files.length,
      modules_total: summary.modulesGenerated,
      modules_failed: summary.modulesFailed,
      orchestrator_path: summary.orchestratorPath,
      entrypoint_path: summary.entrypointPath,
      warnings: summary.warnings,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Reset the build to pending so the user can retry after
      // connecting their key. Same shape as the Phase 1 path.
      await supabase
        .from('builds')
        .update({ status: 'pending' })
        .eq('id', build.id);
      return needsKeyResponse(err)!;
    }
    const message = describeError(err);
    await markSystemBuildFailed(supabase, build.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function describeError(err: unknown): string {
  if (err instanceof SystemCodegenError) return err.message;
  if (err instanceof LLMError) return 'LLM error: ' + err.message;
  if (err instanceof Error) return err.message;
  return 'unknown system codegen error';
}
