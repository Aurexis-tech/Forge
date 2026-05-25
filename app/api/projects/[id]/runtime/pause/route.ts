import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
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
  if (rt.status !== 'active') {
    return NextResponse.json(
      { error: "runtime is in status '" + rt.status + "'; only 'active' can be paused" },
      { status: 409 },
    );
  }

  // Pausing clears next_run_at so the scheduler won't pick it up. Resume
  // will reschedule from the cron expression.
  await setRuntimeStatus(supabase, rt.id, 'paused', { next_run_at: null });
  await audit(supabase, {
    projectId: rt.project_id,
    action: 'runtime.paused',
    actor: 'user',
    detail: { runtime_id: rt.id },
  });
  return NextResponse.json({ status: 'paused' });
}
