import { NextResponse } from 'next/server';
import { z } from 'zod';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import { plan, PlanError } from '@/lib/engine/planner/plan';
import {
  loadLatestPlan,
  loadProjectWithConfirmedSpec,
  markPlanFailed,
  markPlanPlanning,
  mergePlanFeedback,
  persistPlanResult,
} from '@/lib/engine/planner/persistence';
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

  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.1 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  // Pre-flight key gate — bail with 412 if Anthropic isn't connected.
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

  const guard = await loadProjectWithConfirmedSpec(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { parsedSpec } = guard;

  const planRow = await loadLatestPlan(supabase, projectId);
  if (!planRow) {
    return NextResponse.json(
      { error: 'no plan to refine — generate one first' },
      { status: 409 },
    );
  }
  if (planRow.status === 'approved') {
    return NextResponse.json(
      { error: 'plan is already approved; cannot refine' },
      { status: 409 },
    );
  }

  const merged = mergePlanFeedback(planRow.feedback ?? null, {
    refinements: [parsed.data.note],
  } satisfies PlanFeedback);

  try {
    await markPlanPlanning(supabase, planRow.id);

    const { plan: builtPlan, usage, model, attempts } = await plan({
      spec: parsedSpec,
      refinements: merged.refinements,
      governance: { user_id: user.id, project_id: projectId, ref: 'plan.refine' },
    });

    await persistPlanResult({
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
      // Plan was already awaiting_review before refine; revert there
      // so the user can retry after connecting their key.
      await supabase
        .from('plans')
        .update({ status: 'awaiting_review' })
        .eq('id', planRow.id);
      return needsKeyResponse(err)!;
    }
    const message = describeError(err);
    await markPlanFailed(supabase, planRow.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function describeError(err: unknown): string {
  if (err instanceof PlanError) return err.message;
  if (err instanceof LLMError) return `LLM error: ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'unknown planner error';
}
