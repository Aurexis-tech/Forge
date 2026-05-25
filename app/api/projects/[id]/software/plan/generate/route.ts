// POST /api/projects/[id]/software/plan/generate
//
// Phase 3 (Software) — turns a confirmed SoftwareSpec into a
// SoftwareBuildPlan. Parallel to /api/projects/[id]/plan (agent) and
// /api/projects/[id]/system/plan (system); those routes are untouched.
//
// Software stays gated AFTER approval — the build/sandbox/deploy/
// runtime pipeline doesn't exist yet for kind='software'. The
// agent + system planners' loaders 409 this kind, and so does this
// route's own loader when misrouted.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import {
  planSoftware,
  SoftwarePlanError,
} from '@/lib/engine/software/planner/plan';
import {
  ensureSoftwarePlanRow,
  loadProjectWithConfirmedSoftwareSpec,
  markSoftwarePlanFailed,
  markSoftwarePlanPlanning,
  persistSoftwarePlanResult,
} from '@/lib/engine/software/planner/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 180;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.08 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();

  const guard = await loadProjectWithConfirmedSoftwareSpec(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { spec, parsedSpec } = guard;

  const planRow = await ensureSoftwarePlanRow(supabase, projectId, spec.id);
  if (planRow.status === 'approved') {
    return NextResponse.json(
      { error: 'software plan is already approved; cannot regenerate' },
      { status: 409 },
    );
  }

  try {
    await markSoftwarePlanPlanning(supabase, planRow.id);

    const { plan: builtPlan, usage, model, attempts } = await planSoftware({
      spec: parsedSpec,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'software.plan.generate.' + planRow.id,
      },
    });

    await persistSoftwarePlanResult({
      supabase,
      planId: planRow.id,
      projectId,
      plan: builtPlan,
      usage,
      model,
      attempts,
      feedback: null,
      source: 'generate',
    });

    return NextResponse.json({ status: 'awaiting_review', plan: builtPlan });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      await supabase
        .from('plans')
        .update({ status: 'pending' })
        .eq('id', planRow.id);
      return needsKeyResponse(err)!;
    }
    const message = describeError(err);
    await markSoftwarePlanFailed(supabase, planRow.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function describeError(err: unknown): string {
  if (err instanceof SoftwarePlanError) return err.message;
  if (err instanceof LLMError) return 'LLM error: ' + err.message;
  if (err instanceof Error) return err.message;
  return 'unknown software planner error';
}
