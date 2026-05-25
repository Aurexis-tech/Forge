// POST /api/projects/[id]/infra/plan/approve
//
// Mirror of /api/projects/[id]/software/plan/approve for the Phase 4
// infrastructure provisioning plan. Re-validates against
// ProvisioningPlanSchema at the gate so a schema bump never silently
// locks a stale plan.
//
// Approving sets state to 'approved' on the plans row and bumps the
// project status to 'plan_approved'. IMPORTANT: this is the final
// stop for kind='infrastructure' projects in Phase 4 — generation,
// preview, and provisioning stay closed for infrastructure. The
// agent / system / software planner loaders all 409 an infrastructure
// spec; the UI doesn't render those panels for kind='infrastructure'.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import {
  approveInfraPlan,
  loadLatestInfraPlan,
} from '@/lib/engine/infra/planner/persistence';
import { ProvisioningPlanSchema } from '@/lib/engine/infra/planner/schema';
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

  const planRow = await loadLatestInfraPlan(supabase, projectId);
  if (!planRow) {
    return NextResponse.json({ error: 'project has no infrastructure plan' }, { status: 404 });
  }
  if (planRow.status !== 'awaiting_review') {
    return NextResponse.json(
      {
        error:
          "infrastructure plan is in status '" +
          planRow.status +
          "'; only 'awaiting_review' can be approved",
      },
      { status: 409 },
    );
  }

  // Defence in depth — re-run schema validation at the gate. The
  // schema's superRefine reruns dup-id + unknown-dep + execution-order
  // permutation checks automatically.
  const schemaCheck = ProvisioningPlanSchema.safeParse(planRow.plan);
  if (!schemaCheck.success) {
    return NextResponse.json(
      {
        error: 'stored ProvisioningPlan no longer matches the current schema',
        detail: schemaCheck.error.issues.slice(0, 4),
      },
      { status: 422 },
    );
  }

  try {
    const approved = await approveInfraPlan(supabase, planRow);
    return NextResponse.json({ status: 'approved', plan: approved });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to approve infrastructure plan';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
