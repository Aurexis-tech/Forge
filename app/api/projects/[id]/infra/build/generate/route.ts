// POST /api/projects/[id]/infra/build/generate
//
// Phase 4-3 (Infrastructure) IaC GENERATION — turns an approved
// ProvisioningPlan into Terraform files by COMPOSING the closed
// catalog of vetted modules. Parallel to:
//   - /api/projects/[id]/build/generate           (agent, Phase 1)
//   - /api/projects/[id]/system/build/generate    (system, Phase 2)
//   - /api/projects/[id]/software/build/generate  (software, Phase 3)
// All three stay untouched.
//
// THREE NON-NEGOTIABLES this route inherits (enforced by the
// composer + validator, not by prompting):
//
//   1. EVERY block traces to a CATALOG module. The composer NEVER
//      emits freehand `resource "..."` or `data "..."`; the
//      validator HARD-FAILS if any slip in.
//   2. SECURE DEFAULTS — private-by-default, TLS, least-privilege
//      IAM, KMS — baked into the modules. The aggregated summary is
//      logged + surfaced to the UI.
//   3. NOTHING IS APPLIED — generation is INERT. NO `terraform init`,
//      NO `terraform plan`, NO `terraform apply`, NO cloud API call.
//      The audit row records this explicitly.
//
// An infrastructure build STOPS after codegen — preview (P4-4),
// provision/apply (P4-5), and runtime (P4-6) stay closed for
// kind='infrastructure'. The Phases 1/2/3 codegen loaders 409 an
// infra project with the "use the infra route" hint.

import { NextResponse } from 'next/server';
import {
  completeInfraCodegen,
  ensureInfraCodegenBuild,
  loadApprovedInfraPlanForCodegen,
  logInfraCodegenStarted,
  markInfraBuildFailed,
  markInfraBuildGenerating,
  storeInfraBuildFiles,
} from '@/lib/engine/infra/codegen/persistence';
import {
  generateInfraCode,
  InfraCodegenError,
} from '@/lib/engine/infra/codegen/generate';
import { projectRouteGuard } from '@/lib/route-guard';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// IaC generation is fully deterministic + small (a handful of plan
// steps → a handful of .tf files). It should finish well under
// 30 seconds; cap at 120s defensively.
export const maxDuration = 120;

interface RouteContext {
  params: { id: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const projectId = params.id;

  // Governance pre-flight — kill switch + budget. Codegen here is
  // deterministic (no LLM round, no model spend), but the kill
  // switch + ownership posture STILL applies. Pass 0 projected cost
  // so the budget guard reads honestly: this action is free.
  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }

  // No ensureBYOK call — the composer is fully deterministic, with
  // no LLM dependency. If a future iteration adds an LLM detail pass
  // for narrow parameter values, ensureBYOK('anthropic') would land
  // exactly here.

  const supabase = getServerSupabase();

  const guard = await loadApprovedInfraPlanForCodegen(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { plan, spec, parsedPlan, parsedSpec } = guard;

  const buildResult = await ensureInfraCodegenBuild(
    supabase,
    projectId,
    plan.id,
    spec.id,
  );
  if ('error' in buildResult) {
    return NextResponse.json(
      { error: buildResult.error },
      { status: buildResult.status },
    );
  }
  const build = buildResult.build;

  try {
    await logInfraCodegenStarted(supabase, build);
    await markInfraBuildGenerating(supabase, build.id);

    const summary = generateInfraCode({
      spec: parsedSpec,
      plan: parsedPlan,
    });

    await storeInfraBuildFiles(supabase, build.id, summary);
    await completeInfraCodegen(supabase, build, summary);

    if (!summary.structural_ok) {
      // Static validation HARD-FAIL: surface the first failing per-
      // file reason so a future composer regression is loud.
      const firstFailure = summary.static_checks.find(
        (c) => c.status === 'failed',
      );
      return NextResponse.json(
        {
          status: 'failed',
          kind: 'infrastructure',
          build_id: build.id,
          error:
            'infra static validation failed: ' +
            (firstFailure?.error ?? 'unknown structural issue'),
          static_checks: summary.static_checks,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      status: 'generated',
      kind: 'infrastructure',
      build_id: build.id,
      files_total: summary.files.length,
      files_by_layer: summary.files_by_layer,
      module_ids_used: summary.module_ids_used,
      secure_defaults: summary.secure_defaults,
      public_exposure_opt_ins: summary.public_exposure_opt_ins,
      // Belt-and-braces marker in the response: this generation was
      // INERT. Apply lands in P4-5 behind a typed destructive gate.
      cloud_calls: 0,
      terraform_plan_invoked: false,
      terraform_apply_invoked: false,
    });
  } catch (err) {
    const message =
      err instanceof InfraCodegenError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'unknown infra codegen error';
    await markInfraBuildFailed(supabase, build.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
