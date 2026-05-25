import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import {
  approvePlan,
  loadLatestPlan,
} from '@/lib/engine/planner/persistence';
import {
  BuildPlanSchema,
  validatePlanTools,
  validateTaskGraph,
  issuesToErrorString,
} from '@/lib/engine/planner/schema';
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

  const planRow = await loadLatestPlan(supabase, projectId);
  if (!planRow) {
    return NextResponse.json({ error: 'project has no plan' }, { status: 404 });
  }
  if (planRow.status !== 'awaiting_review') {
    return NextResponse.json(
      {
        error: `plan is in status '${planRow.status}'; only 'awaiting_review' can be approved`,
      },
      { status: 409 },
    );
  }

  // Defence in depth — re-run the full validation chain at the gate.
  const schemaCheck = BuildPlanSchema.safeParse(planRow.plan);
  if (!schemaCheck.success) {
    return NextResponse.json(
      {
        error: 'stored plan no longer matches the current schema',
        detail: schemaCheck.error.issues.slice(0, 4),
      },
      { status: 422 },
    );
  }
  const dag = validateTaskGraph(schemaCheck.data.tasks);
  const tools = validatePlanTools(schemaCheck.data);
  if (dag.length > 0 || tools.length > 0) {
    return NextResponse.json(
      {
        error: `plan failed gate validation: ${issuesToErrorString(dag, tools)}`,
      },
      { status: 422 },
    );
  }

  try {
    const approved = await approvePlan(supabase, planRow);
    return NextResponse.json({ status: 'approved', plan: approved });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to approve plan';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
