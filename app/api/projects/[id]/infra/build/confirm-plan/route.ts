// POST /api/projects/[id]/infra/build/confirm-plan
//
// Phase 4-5a — the GATE. After /infra/build/plan ran a real
// `terraform plan` and persisted the diff, this route accepts the
// user's confirmation:
//
//   - PURE-CREATE plan -> `{ authorized: true }` (standard
//     AuthorizationGate). Click + click; same shape as every other
//     authorisation gate in the engine.
//   - DESTRUCTIVE plan -> `{ authorized: true, typed_confirm: "..." }`.
//     The typed_confirm string MUST EXACTLY match the plan row's
//     `typed_phrase_required` ("DESTROY <slug>"). A click without
//     the exact phrase is REFUSED 403. Server-side verification is
//     non-negotiable — a hostile client cannot bypass this by
//     omitting the typed phrase.
//
// PASSING the gate:
//   - moves the build to 'plan_confirmed'
//   - stamps the plan row with the confirming user + timestamp
//   - audits `infra.plan_confirmed` with destructive flag +
//     typed-phrase-verified marker
//   - DOES NOT apply anything. The apply (P4-5b) is a separate gated
//     step. The audit row records `terraform_apply_invoked: false`.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { safeEqual } from '@/lib/crypto';
import {
  confirmInfraPlanRow,
  loadLatestInfraPlanRow,
  loadPreviewedInfraBuildForPlan,
  logInfraPlanConfirmed,
  markInfraBuildPlanConfirmed,
} from '@/lib/engine/infra/cloud/persistence';
import { projectRouteGuard } from '@/lib/route-guard';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

// `authorized: true` is required either way; `typed_confirm` is
// optional in the schema but the destructive-plan branch below
// REQUIRES it (server-side, not via the schema). Defence in depth
// even when the UI's gate is correctly mounted.
const BodySchema = z.object({
  authorized: z.literal(true),
  typed_confirm: z.string().trim().min(1).max(200).optional(),
});

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;

  const routeGuard = await projectRouteGuard(projectId, { projectedCostUsd: 0 });
  if ('error' in routeGuard) {
    return NextResponse.json(routeGuard.body, { status: routeGuard.status });
  }
  const { user } = routeGuard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'request body must include { "authorized": true, (typed_confirm if destructive) } — the user must explicitly approve the plan',
      },
      { status: 403 },
    );
  }

  const supabase = getServerSupabase();

  const ctx = await loadPreviewedInfraBuildForPlan(supabase, projectId);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { build } = ctx;

  // Latest plan row — required. A confirm without a prior plan row is
  // a 409 ("run /infra/build/plan first").
  const planRow = await loadLatestInfraPlanRow(supabase, build.id);
  if (!planRow) {
    return NextResponse.json(
      {
        error:
          'no infrastructure plan exists for this build — run /infra/build/plan first',
      },
      { status: 409 },
    );
  }

  // If the plan was OVER BUDGET, refuse the confirm. The user must
  // raise the ceiling and re-plan first.
  if (planRow.ceiling_verdict === 'over_budget') {
    return NextResponse.json(
      {
        error:
          'this plan was over budget — raise your ceiling and re-plan before confirming',
      },
      { status: 402 },
    );
  }

  // ---------------- TYPED-CONFIRM verification ----------------
  //
  // For destructive plans the typed_confirm MUST be present AND
  // match the plan row's typed_phrase_required EXACTLY. We compare
  // in constant time via safeEqual so a timing oracle can't
  // narrow the phrase character-by-character.
  let typedPhraseVerified = false;
  if (planRow.destructive) {
    const required = planRow.typed_phrase_required ?? '';
    const supplied = (parsed.data.typed_confirm ?? '').trim();
    if (!supplied || !required) {
      return NextResponse.json(
        {
          error:
            'this plan is destructive — a click is not enough. Send `typed_confirm: "' +
            required +
            '"` to confirm.',
          typed_phrase_required: required,
          destroy_count: planRow.destroy_count,
          change_count: planRow.change_count,
        },
        { status: 403 },
      );
    }
    if (!safeEqual(supplied, required)) {
      return NextResponse.json(
        {
          error:
            'typed confirm did not match — you must type the exact phrase to confirm a destructive plan',
          typed_phrase_required: required,
        },
        { status: 403 },
      );
    }
    typedPhraseVerified = true;
  } else {
    // Pure-create — the AuthorizationGate's { authorized: true } is
    // sufficient. We persist `typed_phrase_verified: true` vacuously
    // so the audit row reads consistently across both gate shapes.
    typedPhraseVerified = true;
  }

  await confirmInfraPlanRow(supabase, {
    planId: planRow.id,
    userId: user.id,
    typedPhraseVerified,
  });
  await markInfraBuildPlanConfirmed(supabase, build.id);
  await logInfraPlanConfirmed(supabase, build, {
    plan_id: planRow.id,
    destructive: planRow.destructive,
    typed_phrase_verified: typedPhraseVerified,
    create_count: planRow.create_count,
    change_count: planRow.change_count,
    destroy_count: planRow.destroy_count,
  });

  return NextResponse.json({
    status: 'plan_confirmed',
    kind: 'infrastructure',
    build_id: build.id,
    plan_id: planRow.id,
    destructive: planRow.destructive,
    // Belt + braces — even the SUCCESS response carries the boundary
    // marker. P4-5a never writes to cloud.
    terraform_apply_invoked: false,
    cloud_write_count: 0,
  });
}
