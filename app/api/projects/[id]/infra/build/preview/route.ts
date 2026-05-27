// POST /api/projects/[id]/infra/build/preview
//
// Phase 4-4 (Infrastructure) PREVIEW + COST CEILING GATE — turns a
// 'generated' infra build into:
//
//   1. a human-readable preview of WHAT WOULD BE CREATED, grouped by
//      layer (network → data → compute → observability), derived
//      deterministically from the catalog + composed IaC.
//   2. an ESTIMATED monthly + hourly cost via the infra pricing
//      model, with a per-module breakdown.
//   3. a CEILING VERDICT — within_budget / over_budget / no_budget_set.
//      A within-budget verdict UNLOCKS provisioning (still gated by
//      P4-5); an over-budget verdict BLOCKS provisioning and persists
//      an `infra.preview_over_budget` audit row.
//
// THE PREVIEW IS INERT — same boundary as P4-3:
//   - NO `terraform init` / `plan` / `apply`
//   - NO cloud-provider API call
//   - NO LLM round (the composer + estimator are deterministic;
//     `assertAllowed` still fires for kill-switch coverage)
//
// The audit row records `cloud_calls: 0`, `terraform_plan_invoked:
// false`, `terraform_apply_invoked: false` so the boundary is
// auditable in the same way P4-3's codegen audit is.

import { NextResponse } from 'next/server';
import { projectRouteGuard } from '@/lib/route-guard';
import {
  evaluateCostCeiling,
} from '@/lib/engine/infra/preview/ceiling';
import {
  deriveInfraPreview,
} from '@/lib/engine/infra/preview/derive';
import {
  loadGeneratedInfraBuildForPreview,
  logInfraPreviewCompleted,
  logInfraPreviewFailed,
  logInfraPreviewOverBudget,
  logInfraPreviewStarted,
  markInfraBuildPreviewBlocked,
  markInfraBuildPreviewed,
  markInfraBuildPreviewing,
  persistInfraPreview,
  sanitizeInfraPreviewForResponse,
} from '@/lib/engine/infra/preview/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// Preview derivation is fully deterministic + small. 60s ceiling
// is plenty.
export const maxDuration = 60;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;

  // Governance pre-flight. The preview itself spends nothing, but
  // the kill switch + ownership posture STILL applies — a paused
  // project must stop here too.
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  const supabase = getServerSupabase();

  const ctx = await loadGeneratedInfraBuildForPreview(supabase, projectId);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { build, spec, plan } = ctx;

  await logInfraPreviewStarted(supabase, build);
  await markInfraBuildPreviewing(supabase, build.id);

  let preview;
  try {
    // Derive the public-exposure opt-in set from the InfraSpec so
    // the preview can tag http_service steps accurately.
    const publicHttpServiceResourceIds = spec.resources
      .filter(
        (r) => r.type === 'http_service' && r.config?.public === true,
      )
      .map((r) => r.id);

    preview = deriveInfraPreview({
      plan,
      publicHttpServiceResourceIds,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'unknown preview derivation error';
    await logInfraPreviewFailed(supabase, build, message);
    // Roll status back to 'generated' so a retry can fire.
    await supabase
      .from('builds')
      .update({ status: 'generated' })
      .eq('id', build.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  let ceiling;
  try {
    ceiling = await evaluateCostCeiling({
      userId: user.id,
      projectedUsdPerMonth: preview.total_usd_per_month,
      supabase,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'unknown ceiling check error';
    await logInfraPreviewFailed(supabase, build, message);
    await supabase
      .from('builds')
      .update({ status: 'generated' })
      .eq('id', build.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Persist the preview row regardless of verdict — the audit + UI
  // need the receipt either way.
  let persisted;
  try {
    persisted = await persistInfraPreview(supabase, {
      projectId,
      buildId: build.id,
      preview,
      ceiling,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'failed to persist preview';
    await logInfraPreviewFailed(supabase, build, message);
    await supabase
      .from('builds')
      .update({ status: 'generated' })
      .eq('id', build.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (ceiling.verdict === 'over_budget') {
    await markInfraBuildPreviewBlocked(supabase, build.id);
    await logInfraPreviewOverBudget(supabase, build, {
      preview_id: persisted.id,
      estimated_usd_per_month: preview.total_usd_per_month,
      // verdict === 'over_budget' guarantees a binding period + cap.
      ceiling_period: ceiling.binding_period ?? 'monthly',
      ceiling_limit_usd: ceiling.binding_limit_usd ?? 0,
      ceiling_projected_usd: ceiling.projected_usd_for_binding ?? 0,
      message: ceiling.message,
      cloud_calls: 0,
      terraform_plan_invoked: false,
      terraform_apply_invoked: false,
    });
    return NextResponse.json(
      {
        status: 'preview_blocked',
        kind: 'infrastructure',
        build_id: build.id,
        preview: sanitizeInfraPreviewForResponse(persisted),
        // Even when blocked, the response carries the same boundary
        // markers the codegen audit row uses.
        cloud_calls: 0,
        terraform_plan_invoked: false,
        terraform_apply_invoked: false,
      },
      // 402 Payment Required — same status the governance budget
      // block uses, which is the cleanest signal for "money".
      { status: 402 },
    );
  }

  // within_budget OR no_budget_set → provisioning is unlocked (still
  // gated by the P4-5 typed confirm).
  await markInfraBuildPreviewed(supabase, build.id);
  await logInfraPreviewCompleted(supabase, build, {
    preview_id: persisted.id,
    estimated_usd_per_month: preview.total_usd_per_month,
    estimated_usd_per_hour: preview.total_usd_per_hour,
    ceiling_verdict: ceiling.verdict === 'within_budget'
      ? 'within_budget'
      : 'no_budget_set',
    ceiling_period: ceiling.binding_period,
    ceiling_limit_usd: ceiling.binding_limit_usd,
    public_exposure_opt_ins: preview.public_exposure_opt_ins,
    resource_count: preview.summary.resource_count,
    module_count: preview.summary.module_count,
    cloud_calls: 0,
    terraform_plan_invoked: false,
    terraform_apply_invoked: false,
  });

  return NextResponse.json({
    status: 'previewed',
    kind: 'infrastructure',
    build_id: build.id,
    preview: sanitizeInfraPreviewForResponse(persisted),
    cloud_calls: 0,
    terraform_plan_invoked: false,
    terraform_apply_invoked: false,
  });
}
