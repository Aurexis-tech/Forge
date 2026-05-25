// POST /api/projects/[id]/software/plan/approve
//
// Mirror of /api/projects/[id]/system/plan/approve for the Phase 3
// software build plan. Re-validates against SoftwareBuildPlanSchema
// at the gate so a schema bump never silently locks a stale plan.
//
// Approving sets state to 'approved' on the plans row and bumps the
// project status to 'plan_approved'. IMPORTANT: this is the final
// stop for kind='software' projects in Phase 3 — generation, sandbox,
// deploy, and runtime stay closed for software. The Phase 1 planner +
// system planner loaders both 409 a software spec; the UI doesn't
// render those panels for kind='software'.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import {
  approveSoftwarePlan,
  loadLatestSoftwarePlan,
} from '@/lib/engine/software/planner/persistence';
import { SoftwareBuildPlanSchema } from '@/lib/engine/software/planner/schema';
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

  const planRow = await loadLatestSoftwarePlan(supabase, projectId);
  if (!planRow) {
    return NextResponse.json({ error: 'project has no software plan' }, { status: 404 });
  }
  if (planRow.status !== 'awaiting_review') {
    return NextResponse.json(
      {
        error:
          "software plan is in status '" +
          planRow.status +
          "'; only 'awaiting_review' can be approved",
      },
      { status: 409 },
    );
  }

  // Defence in depth — re-run schema validation at the gate. The
  // schema's superRefine reruns dup-id + unknown-dep + slot-layer
  // consistency + execution-order permutation checks automatically.
  const schemaCheck = SoftwareBuildPlanSchema.safeParse(planRow.plan);
  if (!schemaCheck.success) {
    return NextResponse.json(
      {
        error: 'stored SoftwareBuildPlan no longer matches the current schema',
        detail: schemaCheck.error.issues.slice(0, 4),
      },
      { status: 422 },
    );
  }

  try {
    const approved = await approveSoftwarePlan(supabase, planRow);
    return NextResponse.json({ status: 'approved', plan: approved });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to approve software plan';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
