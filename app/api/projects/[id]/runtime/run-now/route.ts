// Manual one-shot execution. Goes through the same executor as the cron
// tick, runs in its own isolated sandbox, and records a `runs` row with
// trigger='manual'.
//
// Allowed only for runtimes in 'active' or 'paused' state. Refuses if a
// run for this runtime is already in flight.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { NeedsKeyError } from '@/lib/engine/keys';
import { loadRuntimeForProject } from '@/lib/engine/runtime/persistence';
import { runOnce } from '@/lib/engine/runtime/scheduler';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const routeGuard = await projectRouteGuard(params.id, { projectedCostUsd: 0.05 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  // Pre-flight key gate — live runs execute in an E2B sandbox.
  const keyBail = await ensureBYOK(user.id, 'e2b');
  if (keyBail) return keyBail;

  const supabase = getServerSupabase();
  const rt = await loadRuntimeForProject(supabase, params.id);
  if (!rt) {
    return NextResponse.json({ error: 'no runtime for this project' }, { status: 404 });
  }
  if (rt.status === 'stopped') {
    return NextResponse.json(
      { error: 'runtime is stopped; reactivate to run again' },
      { status: 409 },
    );
  }

  // Per-runtime concurrency: no double-fire.
  const { data: existing } = await supabase
    .from('runs')
    .select('id')
    .eq('runtime_id', rt.id)
    .eq('status', 'running')
    .limit(1);
  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: 'a run is already in flight for this runtime' },
      { status: 409 },
    );
  }

  try {
    await runOnce(supabase, rt, 'manual');
    // The latest run row reflects the outcome — reload it for the response.
    const { data: latest } = await supabase
      .from('runs')
      .select('id, status, duration_ms, error')
      .eq('runtime_id', rt.id)
      .order('created_at', { ascending: false })
      .limit(1);
    const row = latest?.[0] ?? null;
    return NextResponse.json({
      run_id: row?.id ?? null,
      status: row?.status ?? 'unknown',
      duration_ms: row?.duration_ms ?? null,
      error: row?.error ?? null,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Defence-in-depth: pre-flight should have caught this, but if the
      // key vanishes mid-flight (e.g. user revokes between peek and run),
      // map it back to the friendly 412 instead of leaking a 500.
      return needsKeyResponse(err)!;
    }
    const msg = err instanceof Error ? err.message : 'run-now failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
