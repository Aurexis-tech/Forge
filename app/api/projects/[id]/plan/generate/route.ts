import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import { plan, PlanError } from '@/lib/engine/planner/plan';
import {
  ensurePlanRow,
  loadProjectWithConfirmedSpec,
  markPlanFailed,
  markPlanPlanning,
  persistPlanResult,
} from '@/lib/engine/planner/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 180;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0.1 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  // Pre-flight key gate — bail with 412 if Anthropic isn't connected.
  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();

  const guard = await loadProjectWithConfirmedSpec(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { spec, parsedSpec } = guard;

  const planRow = await ensurePlanRow(supabase, projectId, spec.id);
  if (planRow.status === 'approved') {
    return NextResponse.json(
      { error: 'plan is already approved; cannot regenerate' },
      { status: 409 },
    );
  }

  try {
    await markPlanPlanning(supabase, planRow.id);

    const { plan: builtPlan, usage, model, attempts } = await plan({
      spec: parsedSpec,
      governance: { user_id: user.id, project_id: projectId, ref: 'plan.generate' },
    });

    await persistPlanResult({
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
      // Reset to pending so the user can retry after connecting.
      await supabase
        .from('plans')
        .update({ status: 'pending' })
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
