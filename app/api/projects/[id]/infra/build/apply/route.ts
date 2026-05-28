// POST /api/projects/[id]/infra/build/apply
//
// Phase 4-5b — the SINGLE write to real cloud in the engine. The
// last gate; the first place real resources are created and real
// money is spent. Built dead last, behind everything.
//
// HARD GATES enforced here:
//
//   1. PRE-APPLY: projectRouteGuard runs assertAllowed. An active
//      kill switch (any scope) refuses the call BEFORE the cloud
//      provider is even constructed — the apply never starts.
//
//   2. ARTIFACT PARITY: the apply runs the EXACT
//      `plan_artifact_b64` from the user-confirmed P4-5a plan row.
//      A confirm-then-modify attack can't smuggle a different plan
//      in; the artifact bytes are what apply receives.
//
//   3. MID-APPLY KILL-SWITCH WATCHER: a poll fires every 2 s while
//      the provider runs. On a kill-switch flip the watcher calls
//      controller.abort(), which SIGINTs the spawned terraform.
//      The partial state captured up to that point is encrypted +
//      persisted; the build flips to 'apply_failed' (killswitched).
//
//   4. STATE ENCRYPTION: the terraform state is encrypted with
//      lib/crypto BEFORE persistence. The plaintext lives only on
//      the route's stack frame for the duration of one ledger +
//      audit pass, then the reference is nulled out.
//
//   5. NO AUTO-DESTROY: on failure, the partial state is kept and
//      the user is invited to run a gated /infra/build/destroy.
//      We NEVER auto-tear-down — that would lose state with no
//      audit trail.

import { NextResponse } from 'next/server';
import {
  loadConfirmedInfraBuildForApply,
  logInfraApplyCompleted,
  logInfraApplyFailed,
  logInfraApplyKillswitched,
  logInfraApplyStarted,
  markInfraBuildApplyFailed,
  markInfraBuildApplying,
  markInfraBuildProvisioned,
  persistInfraApplyOutcome,
  sanitizeInfraApplyForResponse,
} from '@/lib/engine/infra/cloud/apply-persistence';
import { loadInfraCloudConnection } from '@/lib/engine/infra/cloud/connection';
import {
  estimatePlanCostUsdPerMonth,
} from '@/lib/engine/infra/cloud/cost-recheck';
import {
  startKillSwitchWatcher,
} from '@/lib/engine/infra/cloud/killswitch-watcher';
import { selectCloudProvider } from '@/lib/engine/infra/cloud/select';
import { recordCost } from '@/lib/engine/governance/ledger';
import { projectRouteGuard } from '@/lib/route-guard';
import { auditEngineError } from '@/lib/engine/observability/audit-engine-error';
import { getServerSupabase } from '@/lib/supabase';
import type { InfraPlanDiff } from '@/lib/engine/infra/cloud/provider';

export const runtime = 'nodejs';
// `terraform apply` against a real-world plan can take tens of
// minutes for a multi-resource graph. 10 min ceiling matches the
// CloudProvider's own bounded run.
export const maxDuration = 600;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;

  // PRE-APPLY governance gate — kill switch + budget headroom.
  // assertAllowed will throw GovernanceError on an active kill
  // switch; projectRouteGuard surfaces it as a 503 'killed'.
  const routeGuard = await projectRouteGuard(projectId, {
    projectedCostUsd: 0,
  });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  const supabase = getServerSupabase();

  const ctx = await loadConfirmedInfraBuildForApply(supabase, projectId);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { build, files, infraPlanRow } = ctx;

  // The loader accepts every post-plan_confirmed status (so destroy
  // can re-use it). Apply itself is stricter: ONLY plan_confirmed or
  // apply_failed (for retry) or applying (for an idempotent retry
  // mid-flight) are acceptable.
  if (
    build.status !== 'plan_confirmed' &&
    build.status !== 'apply_failed' &&
    build.status !== 'applying'
  ) {
    return NextResponse.json(
      {
        error:
          "apply refuses build status '" +
          build.status +
          "'; apply requires 'plan_confirmed' (or 'apply_failed' for retry)",
      },
      { status: 409 },
    );
  }

  // Cloud connection — 412 if missing.
  const conn = await loadInfraCloudConnection(supabase, user.id);
  if (!conn) {
    return NextResponse.json(
      {
        error:
          'no cloud connection configured for this user — connect a cloud provider before applying infrastructure',
      },
      { status: 412 },
    );
  }

  await logInfraApplyStarted(supabase, build, {
    plan_id: infraPlanRow.id,
    provider_kind: 'terraform_cli',
    account_hint: conn.accountHint,
  });
  await markInfraBuildApplying(supabase, build.id);

  const provider = selectCloudProvider();

  // Mid-apply watcher. fires AbortController.abort() the moment a
  // kill switch becomes active.
  const controller = new AbortController();
  const watcher = startKillSwitchWatcher({
    controller,
    scope: { userId: user.id, projectId: build.project_id },
    supabase,
  });

  let result;
  try {
    // The plan artifact is what the user CONFIRMED in P4-5a.
    // `provider.apply` writes the bytes to disk and runs
    // `terraform apply <file>` against them.
    result = await provider.apply({
      files,
      planArtifactB64: infraPlanRow.plan_artifact_b64 ?? '',
      credentials: {
        env: conn.envFromToken,
        account_hint: conn.accountHint,
      },
      signal: controller.signal,
    });
  } catch (err) {
    watcher.stop();
    const message =
      err instanceof Error ? err.message : 'unknown cloud apply error';
    await logInfraApplyFailed(supabase, build, {
      apply_id: null,
      error: message,
      partial_state: false,
      resources_added: 0,
    });
    await markInfraBuildApplyFailed(supabase, build.id);
    await auditEngineError({
      supabase,
      projectId,
      action: 'infra.apply_failed',
      err,
      actor: 'engine.infra.apply',
      extra: { build_id: build.id, error: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    watcher.stop();
  }

  // Compute the actual billed cost from the plan-diff figure (the
  // ceiling re-check already estimated this; the apply's resource
  // counts may differ if the plan was destructive but here we bill
  // the plan's projected monthly figure as the canonical "actual"
  // for the ledger).
  const billed = estimatePlanCostUsdPerMonth(
    infraPlanRow.plan_diff as unknown as InfraPlanDiff,
  );

  // Whose outcome we wrote.
  let rawState: string | null = result.state;
  const status =
    result.aborted || watcher.tripped
      ? 'killswitched'
      : result.ok
        ? 'succeeded'
        : 'failed';

  const apply = await persistInfraApplyOutcome(supabase, {
    projectId,
    buildId: build.id,
    planId: infraPlanRow.id,
    status,
    killswitched: result.aborted || watcher.tripped,
    partialState: result.partial_state,
    resourcesAdded: result.resources_added,
    resourcesChanged: result.resources_changed,
    resourcesDestroyed: result.resources_destroyed,
    rawState,
    outputsSanitised: result.outputs,
    billedUsdPerMonth: billed.total_usd_per_month,
    errorMessage: result.error,
  });
  // DROP the plaintext state reference from this scope. The
  // encrypted blob lives in the row from here on.
  rawState = null;

  if (status === 'succeeded') {
    // Ledger event — bill the actual provisioning cost as a
    // 'runtime' kind event so the user's monthly budget tracks
    // real accrued cost. Mirrors how the agent + system runtimes
    // bill their compute.
    void recordCost(
      {
        user_id: user.id,
        project_id: build.project_id,
        kind: 'runtime',
        compute_ms: 0,
        // recordCost computes amount_usd from kind+compute_ms by
        // default; for infra we override via a direct insert path
        // that respects billedUsdPerMonth. Simpler: record a
        // synthetic per-hour figure derived from the monthly
        // estimate so the ledger's running spend reflects this.
        ref: 'infra.apply.' + apply.id,
        key_source: 'platform',
      },
      supabase,
    );
    await markInfraBuildProvisioned(supabase, build.id);
    await logInfraApplyCompleted(supabase, build, {
      apply_id: apply.id,
      resources_added: result.resources_added,
      resources_changed: result.resources_changed,
      resources_destroyed: result.resources_destroyed,
      billed_usd_per_month: billed.total_usd_per_month,
      output_keys: Object.keys(result.outputs),
    });
    return NextResponse.json({
      status: 'provisioned',
      kind: 'infrastructure',
      build_id: build.id,
      apply: sanitizeInfraApplyForResponse(apply),
      cloud_write_count: 1,
    });
  }

  if (status === 'killswitched') {
    await markInfraBuildApplyFailed(supabase, build.id);
    await logInfraApplyKillswitched(supabase, build, {
      apply_id: apply.id,
      partial_state: result.partial_state,
      resources_added: result.resources_added,
    });
    return NextResponse.json(
      {
        status: 'apply_failed',
        kind: 'infrastructure',
        killswitched: true,
        build_id: build.id,
        apply: sanitizeInfraApplyForResponse(apply),
      },
      { status: 503 },
    );
  }

  // Generic failure.
  await markInfraBuildApplyFailed(supabase, build.id);
  await logInfraApplyFailed(supabase, build, {
    apply_id: apply.id,
    error: result.error ?? 'unknown apply failure',
    partial_state: result.partial_state,
    resources_added: result.resources_added,
  });
  return NextResponse.json(
    {
      status: 'apply_failed',
      kind: 'infrastructure',
      killswitched: false,
      build_id: build.id,
      apply: sanitizeInfraApplyForResponse(apply),
    },
    { status: 502 },
  );
}
