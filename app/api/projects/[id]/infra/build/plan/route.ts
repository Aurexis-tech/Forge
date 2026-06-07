// POST /api/projects/[id]/infra/build/plan
//
// Phase 4-5a (Infrastructure) — REAL `terraform plan` against actual
// cloud state. The FIRST real cloud call in the engine. READ-ONLY:
// the route invokes the CloudProvider's `plan()` method only;
// `apply()` is P4-5b, a separate gated step.
//
// HARD PREREQUISITE: a within-budget P4-4 preview (status='previewed'
// with ceiling_verdict in {'within_budget','no_budget_set'}). A
// 'generated' build refuses with 409 ("run the preview first"); a
// 'preview_blocked' build refuses with 402 ("raise the ceiling and
// re-preview before planning").
//
// FLOW:
//
//   1. projectRouteGuard — auth + ownership + kill switch + budget
//      headroom (projected cost = 0 here; the plan itself doesn't
//      bill, and the per-resource cost re-check fires further down).
//   2. loadPreviewedInfraBuildForPlan — refuses every misroute.
//   3. loadConnectionWithToken('cloud') — 412 if no cloud connection.
//   4. selectCloudProvider() → plan() with the user's decrypted
//      creds. The diff is sanitised by the provider before return —
//      no secret-shaped strings ever land in our DB or audit row.
//   5. estimatePlanCostUsdPerMonth(diff) → re-check ceiling. Over-
//      budget → 402 + plan_blocked + audit infra.plan_over_budget.
//   6. Persist the plan row with destructive flag + typed-phrase
//      requirement (when destructive). Audit infra.plan_completed +
//      (when destructive) infra.destructive_confirm_required.
//
// NOTHING IS APPLIED HERE. The audit row records
// `terraform_apply_invoked: false` and `cloud_write_count: 0` so
// the boundary is auditable.

import { NextResponse } from 'next/server';
import { decryptSecret } from '@/lib/crypto';
import { selectCloudProvider } from '@/lib/engine/infra/cloud/select';
import {
  estimatePlanCostUsdPerMonth,
} from '@/lib/engine/infra/cloud/cost-recheck';
import {
  loadInfraCloudConnection,
} from '@/lib/engine/infra/cloud/connection';
import {
  loadPreviewedInfraBuildForPlan,
  logDestructiveConfirmRequired,
  logInfraPlanCompleted,
  logInfraPlanFailed,
  logInfraPlanOverBudget,
  logInfraPlanStarted,
  markInfraBuildPlanBlocked,
  markInfraBuildPlanning,
  persistInfraPlanRow,
  sanitizeInfraPlanForResponse,
} from '@/lib/engine/infra/cloud/persistence';
import {
  evaluateCostCeiling,
} from '@/lib/engine/infra/preview/ceiling';
import { projectRouteGuard } from '@/lib/route-guard';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// `terraform init` + `terraform plan -json` are bounded by the
// CloudProvider's own timeout (5 min). 600s ceiling here gives
// headroom for the surrounding DB writes + audit log.
export const maxDuration = 300;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;

  // Governance pre-flight. The plan itself doesn't bill the ledger
  // (read-only against cloud state), but the kill switch + budget
  // headroom STILL apply.
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  const supabase = getServerSupabase();

  // --- Walk the chain. Hard prerequisites enforced here. ---
  const ctx = await loadPreviewedInfraBuildForPlan(supabase, projectId);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { build, files, preview } = ctx;

  // --- Cloud connection (412 when missing). The CloudProvider seam
  // is the ONLY consumer of these creds; the decrypted value lives
  // for the duration of this request only. ---
  const conn = await loadInfraCloudConnection(supabase, user.id);
  if (!conn) {
    return NextResponse.json(
      {
        error:
          'no cloud connection configured for this user — connect a cloud provider before planning infrastructure',
      },
      { status: 412 },
    );
  }

  await logInfraPlanStarted(supabase, build, {
    provider_kind: 'terraform_cli',
    account_hint: conn.accountHint,
  });
  await markInfraBuildPlanning(supabase, build.id);

  // --- Run the REAL plan via the CloudProvider seam. The provider
  // sanitises the diff at its boundary; the secret-shaped strings
  // are scrubbed before the diff reaches us. The plan artifact is
  // saved to disk so the apply step can pass it back verbatim. ---
  const provider = selectCloudProvider();
  let planResult;
  try {
    planResult = await provider.plan({
      files,
      credentials: {
        env: conn.envFromToken,
        account_hint: conn.accountHint,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'unknown cloud plan error';
    await logInfraPlanFailed(supabase, build, message);
    // Roll back to 'previewed' so a retry can fire.
    await supabase
      .from('builds')
      .update({ status: 'previewed' })
      .eq('id', build.id);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // --- Re-check the cost ceiling against the REAL plan. The P4-4
  // estimate is irrelevant here; this is the authoritative number. ---
  const diff = planResult.diff;
  const breakdown = estimatePlanCostUsdPerMonth(diff);
  let ceiling;
  try {
    ceiling = await evaluateCostCeiling({
      userId: user.id,
      projectedUsdPerMonth: breakdown.total_usd_per_month,
      supabase,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'unknown ceiling re-check error';
    await logInfraPlanFailed(supabase, build, message);
    await supabase
      .from('builds')
      .update({ status: 'previewed' })
      .eq('id', build.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Destructive plans require a server-verified TYPED CONFIRM. The
  // exact phrase is "DESTROY <project-name>" — denormalised onto the
  // plan row so the audit + confirm-plan route both read it.
  const typedPhraseRequired = diff.destructive
    ? buildTypedPhrase(ctx.project.name)
    : null;

  const persisted = await persistInfraPlanRow(supabase, {
    projectId,
    buildId: build.id,
    diff,
    ceiling,
    typedPhraseRequired,
    planArtifactB64: planResult.plan_artifact_b64,
  });

  if (ceiling.verdict === 'over_budget') {
    await markInfraBuildPlanBlocked(supabase, build.id);
    await logInfraPlanOverBudget(supabase, build, {
      plan_id: persisted.id,
      estimated_usd_per_month: breakdown.total_usd_per_month,
      ceiling_period: ceiling.binding_period ?? 'monthly',
      ceiling_limit_usd: ceiling.binding_limit_usd ?? 0,
      ceiling_projected_usd: ceiling.projected_usd_for_binding ?? 0,
      message: ceiling.message,
    });
    return NextResponse.json(
      {
        status: 'plan_blocked',
        kind: 'infrastructure',
        build_id: build.id,
        plan: sanitizeInfraPlanForResponse(persisted),
        terraform_apply_invoked: false,
        cloud_write_count: 0,
      },
      { status: 402 }, // payment required — the money-gate signal
    );
  }

  // Within budget → roll status back to 'previewed' so the gate
  // panel mounts. (We don't set 'plan_confirmed' yet — that's the
  // confirm-plan route's job.) The persisted plan row IS what the UI
  // renders; build.status is the page-router signal.
  await supabase
    .from('builds')
    .update({ status: 'previewed' })
    .eq('id', build.id);

  await logInfraPlanCompleted(supabase, build, {
    plan_id: persisted.id,
    create_count: diff.create_count,
    change_count: diff.change_count,
    destroy_count: diff.destroy_count,
    replace_count: diff.replace_count,
    destructive: diff.destructive,
    ceiling_verdict: ceiling.verdict === 'within_budget'
      ? 'within_budget'
      : 'no_budget_set',
    ceiling_period: ceiling.binding_period,
    ceiling_limit_usd: ceiling.binding_limit_usd,
    typed_confirm_required: diff.destructive,
  });

  if (diff.destructive && typedPhraseRequired) {
    await logDestructiveConfirmRequired(supabase, build, {
      plan_id: persisted.id,
      destroy_count: diff.destroy_count,
      replace_count: diff.replace_count,
      change_count: diff.change_count,
      typed_phrase_required: typedPhraseRequired,
    });
  }

  // Suppress the preview row going unused — the route layer keeps it
  // loaded for the audit + future UI surfaces. (Lints would
  // otherwise complain about the unused destructure.)
  void preview;

  return NextResponse.json({
    status: 'planned',
    kind: 'infrastructure',
    build_id: build.id,
    plan: sanitizeInfraPlanForResponse(persisted),
    // Boundary markers — the codegen + preview rows carry the same
    // shape; this route does the same.
    terraform_apply_invoked: false,
    cloud_write_count: 0,
  });
}

/**
 * The exact phrase the destructive-confirm gate requires.
 *
 * Format: `DESTROY <slug>`, where the slug is the project name
 * lowercased + non-alphanum stripped. This is intentionally a
 * non-trivial phrase the user must TYPE — a click is insufficient
 * for an irreversible action.
 */
function buildTypedPhrase(projectName: string): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  return 'DESTROY ' + slug;
}
