// POST /api/projects/[id]/system/plan/refine
//
// Mirror of /api/projects/[id]/plan/refine for the Phase 2 system
// planner. Accepts { note }; re-runs the planner with the user's
// refinement appended to the merged feedback list.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import {
  planSystem,
  SystemPlanError,
} from '@/lib/engine/system/planner/plan';
import {
  loadLatestSystemPlan,
  loadProjectWithConfirmedSystemSpec,
  markSystemPlanFailed,
  markSystemPlanPlanning,
  mergeSystemPlanFeedback,
  persistSystemPlanResult,
} from '@/lib/engine/system/planner/persistence';
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

  const guard = await loadProjectWithConfirmedSystemSpec(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { parsedSpec } = guard;

  const planRow = await loadLatestSystemPlan(supabase, projectId);
  if (!planRow) {
    return NextResponse.json(
      { error: 'no system plan to refine — generate one first' },
      { status: 409 },
    );
  }
  if (planRow.status === 'approved') {
    return NextResponse.json(
      { error: 'system plan is already approved; cannot refine' },
      { status: 409 },
    );
  }

  const merged = mergeSystemPlanFeedback(planRow.feedback ?? null, {
    refinements: [parsed.data.note],
  } satisfies PlanFeedback);

  try {
    await markSystemPlanPlanning(supabase, planRow.id);

    const { plan: builtPlan, usage, model, attempts } = await planSystem({
      spec: parsedSpec,
      refinements: merged.refinements,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'system.plan.refine.' + planRow.id,
      },
    });

    await persistSystemPlanResult({
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
    await markSystemPlanFailed(supabase, planRow.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function describeError(err: unknown): string {
  if (err instanceof SystemPlanError) return err.message;
  if (err instanceof LLMError) return 'LLM error: ' + err.message;
  if (err instanceof Error) return err.message;
  return 'unknown system planner error';
}
