// POST /api/projects/[id]/infra/runtime/check-drift
//
// Phase 4-6 — DRIFT detection. INERT (read-only). Re-runs the
// CloudProvider's `plan()` against the IaC + live cloud state and
// classifies the resulting diff:
//
//   - in_sync — no changes. Live cloud matches the IaC.
//   - drifted — terraform would CREATE / CHANGE / DESTROY at least
//               one resource against current cloud state.
//   - failed  — the plan call itself errored.
//
// Drift is the same read-only operation as P4-5a's plan; we reuse
// the CloudProvider.plan() seam unchanged. NO apply. NO cloud
// write. The route records the boundary marker
// `terraform_apply_invoked: false` + `cloud_write_count: 0` in the
// audit row.
//
// The kill switch FREEZES infra: an active switch refuses this call
// via projectRouteGuard's assertAllowed. The hard stop reaches the
// drift check too — when frozen, no further forward action runs.
//
// 412 when no cloud connection.

import { NextResponse } from 'next/server';
import {
  loadConfirmedInfraBuildForApply,
  loadLatestInfraApply,
} from '@/lib/engine/infra/cloud/apply-persistence';
import { loadInfraCloudConnection } from '@/lib/engine/infra/cloud/connection';
import { selectCloudProvider } from '@/lib/engine/infra/cloud/select';
import {
  logInfraDriftChecked,
  logInfraDriftStarted,
  persistInfraDriftCheck,
} from '@/lib/engine/infra/runtime/persistence';
import { projectRouteGuard } from '@/lib/route-guard';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// Drift = `terraform init -input=false` + `terraform plan -json`.
// Same ceiling as the P4-5a plan route.
export const maxDuration = 600;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;

  // Pre-flight gate — kill switch + budget. An active kill switch
  // FREEZES infra and refuses this call too.
  const routeGuard = await projectRouteGuard(projectId, {
    projectedCostUsd: 0,
  });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  const supabase = getServerSupabase();

  // Reuse the apply-loader. It accepts every post-plan_confirmed
  // status, including 'provisioned' (the monitor entry point).
  const ctx = await loadConfirmedInfraBuildForApply(supabase, projectId);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { build, files } = ctx;

  // Drift only makes sense once the build is at 'provisioned' (or
  // 'apply_failed' if the user wants to see what's STILL live).
  if (build.status !== 'provisioned' && build.status !== 'apply_failed') {
    return NextResponse.json(
      {
        error:
          "drift check refuses build status '" +
          build.status +
          "'; only 'provisioned' (or 'apply_failed') can be drift-checked",
      },
      { status: 409 },
    );
  }

  // Latest apply row — drift is anchored to the apply that
  // provisioned the resources.
  const apply = await loadLatestInfraApply(supabase, build.id);
  if (!apply) {
    return NextResponse.json(
      { error: 'no apply row exists for this build — provision first' },
      { status: 409 },
    );
  }

  // Cloud connection.
  const conn = await loadInfraCloudConnection(supabase, user.id);
  if (!conn) {
    return NextResponse.json(
      {
        error:
          'no cloud connection configured — connect a cloud provider before checking drift',
      },
      { status: 412 },
    );
  }

  await logInfraDriftStarted(supabase, build);

  const provider = selectCloudProvider();
  let result;
  try {
    result = await provider.plan({
      files,
      credentials: {
        env: conn.envFromToken,
        account_hint: conn.accountHint,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'unknown drift check error';
    const drift = await persistInfraDriftCheck(supabase, {
      projectId,
      buildId: build.id,
      applyId: apply.id,
      verdict: 'failed',
      createCount: 0,
      changeCount: 0,
      destroyCount: 0,
      diffSummary: null,
      errorMessage: message,
    });
    await logInfraDriftChecked(supabase, build, {
      drift_id: drift.id,
      verdict: 'failed',
      create_count: 0,
      change_count: 0,
      destroy_count: 0,
    });
    return NextResponse.json(
      {
        status: 'failed',
        kind: 'infrastructure',
        drift_id: drift.id,
        error: message,
        terraform_apply_invoked: false,
        cloud_write_count: 0,
      },
      { status: 502 },
    );
  }

  const diff = result.diff;
  const totalChanges =
    diff.create_count +
    diff.change_count +
    diff.replace_count +
    diff.destroy_count;
  const verdict: 'in_sync' | 'drifted' = totalChanges === 0 ? 'in_sync' : 'drifted';

  // Persist the sanitised diff summary. The CloudProvider already
  // sanitised secret-shaped strings at its boundary; we still
  // serialise via JSON for the column shape.
  const drift = await persistInfraDriftCheck(supabase, {
    projectId,
    buildId: build.id,
    applyId: apply.id,
    verdict,
    createCount: diff.create_count,
    changeCount: diff.change_count,
    // Replace + destroy collapse into the destroy-side count for the
    // dashboard summary (replace = destroy + create; we keep
    // change_count + destroy_count + create_count separate above).
    destroyCount: diff.destroy_count + diff.replace_count,
    diffSummary: {
      resources: diff.resources,
      terraform_version: diff.terraform_version,
    },
    errorMessage: null,
  });
  await logInfraDriftChecked(supabase, build, {
    drift_id: drift.id,
    verdict,
    create_count: diff.create_count,
    change_count: diff.change_count,
    destroy_count: diff.destroy_count + diff.replace_count,
  });

  return NextResponse.json({
    status: verdict,
    kind: 'infrastructure',
    drift_id: drift.id,
    create_count: diff.create_count,
    change_count: diff.change_count,
    destroy_count: diff.destroy_count + diff.replace_count,
    terraform_apply_invoked: false,
    cloud_write_count: 0,
  });
}
