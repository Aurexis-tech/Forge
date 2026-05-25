// Resume a paused or auto-paused (errored) runtime. Reschedules the next
// tick from the cron expression and resets consecutive_fails so a healed
// agent gets a clean start.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { nextRunFromCron } from '@/lib/engine/runtime/cron';
import {
  audit,
  loadRuntimeForProject,
  setRuntimeStatus,
} from '@/lib/engine/runtime/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const routeGuard = await projectRouteGuard(params.id);
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const supabase = getServerSupabase();
  const rt = await loadRuntimeForProject(supabase, params.id);
  if (!rt) {
    return NextResponse.json({ error: 'no runtime for this project' }, { status: 404 });
  }
  if (rt.status !== 'paused' && rt.status !== 'errored') {
    return NextResponse.json(
      {
        error:
          "runtime is in status '" +
          rt.status +
          "'; only 'paused' or 'errored' can be resumed",
      },
      { status: 409 },
    );
  }

  const next = nextRunFromCron(rt.schedule_cron).toISOString();
  await setRuntimeStatus(supabase, rt.id, 'active', {
    next_run_at: next,
    consecutive_fails: 0,
  });
  await audit(supabase, {
    projectId: rt.project_id,
    action: 'runtime.resumed',
    actor: 'user',
    detail: { runtime_id: rt.id, from: rt.status, next_run_at: next },
  });
  return NextResponse.json({ status: 'active', next_run_at: next });
}
