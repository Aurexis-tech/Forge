// POST /api/projects/[id]/system/plan/approve
//
// Mirror of /api/projects/[id]/plan/approve for the Phase 2 system
// orchestration plan. Re-validates against the OrchestrationPlanSchema
// at the gate so a schema bump never silently locks a stale plan.
//
// Approving sets state to 'approved' on the plans row and bumps the
// project status to 'plan_approved'. IMPORTANT: this is the final
// stop for kind='system' projects in Phase 2 — generation, sandbox,
// deploy, and runtime stay closed for systems (the UI doesn't render
// those panels, and the Phase 1 planner's loadProjectWithConfirmedSpec
// already rejects system specs).

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import {
  approveSystemPlan,
  loadLatestSystemPlan,
} from '@/lib/engine/system/planner/persistence';
import { OrchestrationPlanSchema } from '@/lib/engine/system/planner/schema';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;
  const guard = await projectRouteGuard(projectId);
  if ('error' in guard) {
    return NextResponse.json(guard.body, { status: guard.status });
  }
  const supabase = getServerSupabase();

  const planRow = await loadLatestSystemPlan(supabase, projectId);
  if (!planRow) {
    return NextResponse.json({ error: 'project has no system plan' }, { status: 404 });
  }
  if (planRow.status !== 'awaiting_review') {
    return NextResponse.json(
      {
        error:
          "system plan is in status '" +
          planRow.status +
          "'; only 'awaiting_review' can be approved",
      },
      { status: 409 },
    );
  }

  // Defence in depth — re-run schema validation at the gate. The
  // schema's superRefine reruns DAG / handoff / tool-registry checks
  // automatically, so we don't need separate calls here.
  const schemaCheck = OrchestrationPlanSchema.safeParse(planRow.plan);
  if (!schemaCheck.success) {
    return NextResponse.json(
      {
        error: 'stored OrchestrationPlan no longer matches the current schema',
        detail: schemaCheck.error.issues.slice(0, 4),
      },
      { status: 422 },
    );
  }

  try {
    const approved = await approveSystemPlan(supabase, planRow);
    return NextResponse.json({ status: 'approved', plan: approved });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to approve system plan';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
