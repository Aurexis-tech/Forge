// POST /api/projects/[id]/software/plan/refine
//
// Mirror of /api/projects/[id]/system/plan/refine for the Phase 3
// software planner. Accepts { note }; re-runs the planner with the
// user's refinement appended to the merged feedback list.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import {
  planSoftware,
  SoftwarePlanError,
} from '@/lib/engine/software/planner/plan';
import {
  loadLatestSoftwarePlan,
  loadProjectWithConfirmedSoftwareSpec,
  markSoftwarePlanFailed,
  markSoftwarePlanPlanning,
  mergeSoftwarePlanFeedback,
  persistSoftwarePlanResult,
} from '@/lib/engine/software/planner/persistence';
import { getServerSupabase } from '@/lib/supabase';
import type { PlanFeedback } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 180;

const BodySchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;

  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.08 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }

  const supabase = getServerSupabase();

  const guard = await loadProjectWithConfirmedSoftwareSpec(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { parsedSpec } = guard;

  const planRow = await loadLatestSoftwarePlan(supabase, projectId);
  if (!planRow) {
    return NextResponse.json(
      { error: 'no software plan to refine — generate one first' },
      { status: 409 },
    );
  }
  if (planRow.status === 'approved') {
    return NextResponse.json(
      { error: 'software plan is already approved; cannot refine' },
      { status: 409 },
    );
  }

  const merged = mergeSoftwarePlanFeedback(planRow.feedback ?? null, {
    refinements: [parsed.data.note],
  } satisfies PlanFeedback);

  try {
    await markSoftwarePlanPlanning(supabase, planRow.id);

    const { plan: builtPlan, usage, model, attempts } = await planSoftware({
      spec: parsedSpec,
      refinements: merged.refinements,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'software.plan.refine.' + planRow.id,
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
      feedback: merged,
      source: 'refine',
    });

    return NextResponse.json({ status: 'awaiting_review', plan: builtPlan });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      await supabase
        .from('plans')
        .update({ status: 'awaiting_review' })
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
