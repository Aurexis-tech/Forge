// POST /api/projects/[id]/software/build/generate
//
// Phase 3 (Software) codegen — turns an approved SoftwareBuildPlan
// into a Next.js + Supabase application by filling vetted template
// slots. Parallel to /api/projects/[id]/build/generate (agent) and
// /api/projects/[id]/system/build/generate (system); both stay
// untouched.
//
// A software build STOPS after codegen — there's no app sandbox /
// DB provisioning / deploy / runtime path in this prompt. The Phase
// 1 + 2 codegen loaders 409 a software project; this route's own
// loader 409s anything that isn't a confirmed-software spec +
// approved-software plan.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import {
  generateSoftwareCode,
  SoftwareCodegenError,
} from '@/lib/engine/software/codegen/generate';
import {
  completeSoftwareCodegen,
  ensureSoftwareCodegenBuild,
  loadApprovedSoftwarePlanForCodegen,
  logSoftwareCodegenStarted,
  markSoftwareBuildFailed,
  markSoftwareBuildGenerating,
  storeSoftwareBuildFiles,
} from '@/lib/engine/software/codegen/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// Per-slot generation is sequential and each call is 1-2 LLM rounds;
// a 3-page + 2-entity app finishes well under a minute. 300s matches
// the Phase 1 + 2 codegen ceiling.
export const maxDuration = 300;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  // Per-slot LLM calls each go through their own assertAllowed via
  // lib/engine/llm.complete(); this route-level pre-flight is just a
  // cheap fast-fail when the project's already over budget. Budget
  // estimate covers ~10 slots × ~0.05 USD/slot.
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.5 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  // Pre-flight key gate — bail with 412 if Anthropic isn't connected.
  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();

  const guard = await loadApprovedSoftwarePlanForCodegen(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { plan, spec, parsedPlan, parsedSpec } = guard;

  const buildResult = await ensureSoftwareCodegenBuild(
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
    await logSoftwareCodegenStarted(supabase, build);
    await markSoftwareBuildGenerating(supabase, build.id);

    const summary = await generateSoftwareCode({
      spec: parsedSpec,
      plan: parsedPlan,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'software.codegen.generate.' + build.id,
      },
    });

    await storeSoftwareBuildFiles(supabase, build.id, summary);
    await completeSoftwareCodegen(supabase, build, summary);

    return NextResponse.json({
      status: 'generated',
      kind: 'software',
      build_id: build.id,
      files_total: summary.files.length,
      scaffold_count: summary.files.filter((f) => f.source === 'scaffold').length,
      generated_count: summary.files.filter((f) => f.source === 'generated').length,
      slot_counts: summary.slotCounts,
      llm_files_failed: summary.llmFilesFailed,
      warnings: summary.warnings,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      await supabase
        .from('builds')
        .update({ status: 'pending' })
        .eq('id', build.id);
      return needsKeyResponse(err)!;
    }
    const message = describeError(err);
    await markSoftwareBuildFailed(supabase, build.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function describeError(err: unknown): string {
  if (err instanceof SoftwareCodegenError) return err.message;
  if (err instanceof LLMError) return 'LLM error: ' + err.message;
  if (err instanceof Error) return err.message;
  return 'unknown software codegen error';
}
