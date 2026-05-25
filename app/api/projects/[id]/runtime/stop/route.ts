// Stop a runtime — final state. The agent_runtimes row stays in the DB
// for history but no further ticks will fire. The build returns to
// 'pushed' so the user can re-activate fresh.
//
// Stop is always safe — no concurrency block, no auth gate. The cost of
// stopping a healthy runtime is at most one missed tick.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import {
  audit,
  loadRuntimeForProject,
  setBuildStatusFromRuntime,
  setRuntimeStatus,
} from '@/lib/engine/runtime/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  // Stop is always safe; we still require ownership and respect the kill
  // switch (so a paused system stays paused).
  const routeGuard = await projectRouteGuard(params.id);
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const supabase = getServerSupabase();
  const rt = await loadRuntimeForProject(supabase, params.id);
  if (!rt) {
    return NextResponse.json({ error: 'no runtime for this project' }, { status: 404 });
  }
  if (rt.status === 'stopped') {
    return NextResponse.json({ status: 'stopped' });
  }

  await setRuntimeStatus(supabase, rt.id, 'stopped', { next_run_at: null });
  await setBuildStatusFromRuntime(supabase, rt.build_id, 'stopped');

  await audit(supabase, {
    projectId: rt.project_id,
    action: 'runtime.stopped',
    actor: 'user',
    detail: {
      runtime_id: rt.id,
      from: rt.status,
      run_count: rt.run_count,
      fail_count: rt.fail_count,
    },
  });

  return NextResponse.json({ status: 'stopped' });
}
