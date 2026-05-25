// POST /api/projects/[id]/infra/plan/generate
//
// Phase 4 (Infrastructure) — turns a confirmed InfraSpec into a
// ProvisioningPlan. Parallel to /api/projects/[id]/plan (agent),
// /api/projects/[id]/system/plan (system), and
// /api/projects/[id]/software/plan (software); those routes are
// untouched.
//
// Infrastructure stays gated AFTER approval — there is no generation /
// preview / provisioning pipeline yet for kind='infrastructure'. The
// agent / system / software planners' loaders 409 a confirmed
// infrastructure spec, and this route's own loader 409s anything that
// isn't an InfraSpec.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import {
  planInfra,
  InfraPlanError,
} from '@/lib/engine/infra/planner/plan';
import {
  ensureInfraPlanRow,
  loadProjectWithConfirmedInfraSpec,
  markInfraPlanFailed,
  markInfraPlanPlanning,
  persistInfraPlanResult,
} from '@/lib/engine/infra/planner/persistence';
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

  const guard = await loadProjectWithConfirmedInfraSpec(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { spec, parsedSpec } = guard;

  const planRow = await ensureInfraPlanRow(supabase, projectId, spec.id);
  if (planRow.status === 'approved') {
    return NextResponse.json(
      { error: 'infrastructure plan is already approved; cannot regenerate' },
      { status: 409 },
    );
  }

  try {
    await markInfraPlanPlanning(supabase, planRow.id);

    const { plan: builtPlan, usage, model, attempts } = await planInfra({
      spec: parsedSpec,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'infra.plan.generate.' + planRow.id,
      },
    });

    await persistInfraPlanResult({
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
    await markInfraPlanFailed(supabase, planRow.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function describeError(err: unknown): string {
  if (err instanceof InfraPlanError) return err.message;
  if (err instanceof LLMError) return 'LLM error: ' + err.message;
  if (err instanceof Error) return err.message;
  return 'unknown infrastructure planner error';
}
