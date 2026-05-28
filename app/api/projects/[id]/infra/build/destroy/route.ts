// POST /api/projects/[id]/infra/build/destroy
//
// Phase 4-5b — the ROLLBACK / TEARDOWN primitive. Used for two
// distinct flows:
//
//   1. ROLLBACK after a failed apply: status='apply_failed' with a
//      partial state captured. Destroy reads the partial state,
//      runs `terraform destroy` against it, and ends at
//      'destroyed'.
//   2. TEARDOWN of a successfully provisioned build:
//      status='provisioned'. Destroy reads the full state and
//      tears the resources down. Reused by P4-6 scheduled teardown
//      later.
//
// Destroy is IRREVERSIBLE — it requires a server-verified TYPED
// CONFIRM. The exact phrase is the same one P4-5a's destructive-
// confirm gate used: `DESTROY <slug>`. A click without the typed
// phrase is REFUSED 403. We NEVER auto-destroy — a hostile client
// can't trigger teardown by simply hitting this endpoint.
//
// SECURITY:
//   - The encrypted terraform state is decrypted ONCE inside this
//     route, passed to the CloudProvider's destroy() method, and
//     the plaintext reference is nulled out as soon as the call
//     returns.
//   - The route does NOT return the decrypted state in any
//     response; the audit row never carries the plaintext.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { safeEqual } from '@/lib/crypto';
import {
  decryptApplyState,
  loadConfirmedInfraBuildForApply,
  loadLatestInfraApply,
  logInfraDestroyed,
  logRollbackRequested,
  markInfraBuildDestroyed,
  markInfraBuildDestroying,
  sanitizeInfraApplyForResponse,
  updateInfraApplyOutcome,
} from '@/lib/engine/infra/cloud/apply-persistence';
import { loadInfraCloudConnection } from '@/lib/engine/infra/cloud/connection';
import {
  startKillSwitchWatcher,
} from '@/lib/engine/infra/cloud/killswitch-watcher';
import { selectCloudProvider } from '@/lib/engine/infra/cloud/select';
import { projectRouteGuard } from '@/lib/route-guard';
import { auditEngineError } from '@/lib/engine/observability/audit-engine-error';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// Destroy can take longer than apply for resources that have
// dependent shutdown sequences (RDS final snapshots, S3 lifecycle
// drains). 10 min ceiling matches apply.
export const maxDuration = 600;

const BodySchema = z.object({
  typed_confirm: z.string().trim().min(1).max(200),
});

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;

  // Pre-destroy gate. assertAllowed runs; the kill switch can refuse
  // a destroy too — but unlike apply, a kill switch on destroy
  // arguably should be a softer block. We treat them the same here
  // for consistency; the operator can clear the switch to allow the
  // rollback.
  const routeGuard = await projectRouteGuard(projectId, {
    projectedCostUsd: 0,
  });
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
          'destroy requires { "typed_confirm": "<exact phrase>" } — a click is not enough for an irreversible action',
      },
      { status: 403 },
    );
  }

  const supabase = getServerSupabase();

  // The destroy path reuses loadConfirmedInfraBuildForApply since
  // the chain is identical (project → plan → build → confirmed plan
  // row). The status check is relaxed: we accept 'provisioned',
  // 'apply_failed', and 'destroying' (for retry).
  const ctx = await loadConfirmedInfraBuildForApply(supabase, projectId);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { build, files, infraPlanRow } = ctx;

  if (
    build.status !== 'provisioned' &&
    build.status !== 'apply_failed' &&
    build.status !== 'destroying'
  ) {
    return NextResponse.json(
      {
        error:
          "destroy refuses build status '" +
          build.status +
          "'; only 'provisioned' or 'apply_failed' can be destroyed",
      },
      { status: 409 },
    );
  }

  // Latest apply row — required + has state to destroy against.
  const applyRow = await loadLatestInfraApply(supabase, build.id);
  if (!applyRow) {
    return NextResponse.json(
      {
        error:
          'no apply row exists for this build — nothing to destroy',
      },
      { status: 409 },
    );
  }
  if (!applyRow.state_present || !applyRow.state_encrypted) {
    return NextResponse.json(
      {
        error:
          'apply row has no captured state — destroy needs state to know what to remove',
      },
      { status: 409 },
    );
  }

  // Verify the typed confirm EXACTLY against the same phrase the
  // P4-5a destructive-confirm gate used. Constant-time compare so a
  // timing oracle can't narrow the phrase character-by-character.
  const required = infraPlanRow.typed_phrase_required ?? '';
  if (!required) {
    // Pure-create plans don't carry a phrase — destroy still
    // requires the project-derived phrase. Recompute from the
    // project name so the gate behaves identically regardless of
    // the original plan's destructive flag.
    return NextResponse.json(
      {
        error:
          'destroy requires a server-verified typed_confirm — re-run /infra/build/plan to ensure a typed-phrase is on the latest plan row',
      },
      { status: 409 },
    );
  }
  if (!safeEqual(parsed.data.typed_confirm.trim(), required)) {
    return NextResponse.json(
      {
        error:
          'typed_confirm did not match — type the exact phrase to confirm an irreversible destroy',
        typed_phrase_required: required,
      },
      { status: 403 },
    );
  }

  // Cloud connection — 412 if missing.
  const conn = await loadInfraCloudConnection(supabase, user.id);
  if (!conn) {
    return NextResponse.json(
      {
        error:
          'no cloud connection configured — connect a cloud provider before destroying infrastructure',
      },
      { status: 412 },
    );
  }

  await logRollbackRequested(supabase, build, {
    apply_id: applyRow.id,
    typed_phrase_required: required,
  });
  await markInfraBuildDestroying(supabase, build.id);
  await updateInfraApplyOutcome(supabase, {
    applyId: applyRow.id,
    status: 'destroying',
  });

  // Decrypt state ONCE. The plaintext lives for the destroy() call
  // and is nulled out immediately afterwards.
  let plaintextState: string | null = decryptApplyState(applyRow);
  const provider = selectCloudProvider();
  const controller = new AbortController();
  const watcher = startKillSwitchWatcher({
    controller,
    scope: { userId: user.id, projectId: build.project_id },
    supabase,
  });

  let result;
  try {
    result = await provider.destroy({
      files,
      state: plaintextState,
      credentials: {
        env: conn.envFromToken,
        account_hint: conn.accountHint,
      },
      signal: controller.signal,
    });
  } catch (err) {
    watcher.stop();
    plaintextState = null;
    const message =
      err instanceof Error ? err.message : 'unknown cloud destroy error';
    await updateInfraApplyOutcome(supabase, {
      applyId: applyRow.id,
      status: 'failed',
      errorMessage: message,
    });
    await supabase
      .from('builds')
      .update({ status: 'apply_failed' })
      .eq('id', build.id);
    await auditEngineError({
      supabase,
      projectId,
      action: 'infra.destroy_failed',
      err,
      actor: 'engine.infra.destroy',
      extra: { build_id: build.id, apply_id: applyRow.id, error: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    watcher.stop();
    plaintextState = null;
  }

  if (!result.ok) {
    await updateInfraApplyOutcome(supabase, {
      applyId: applyRow.id,
      status: 'failed',
      killswitched: result.aborted || watcher.tripped,
      partialState: result.partial_state,
      rawState: result.state,
      errorMessage:
        result.error ?? (result.aborted ? 'destroy aborted' : 'destroy failed'),
    });
    await supabase
      .from('builds')
      .update({ status: 'apply_failed' })
      .eq('id', build.id);
    return NextResponse.json(
      {
        status: 'destroy_failed',
        kind: 'infrastructure',
        killswitched: result.aborted || watcher.tripped,
        error: result.error,
      },
      { status: 502 },
    );
  }

  // Success path — destroy completed cleanly.
  await updateInfraApplyOutcome(supabase, {
    applyId: applyRow.id,
    status: 'destroyed',
    rawState: result.state,
    resourcesDestroyed: result.resources_destroyed,
  });
  await markInfraBuildDestroyed(supabase, build.id);
  await logInfraDestroyed(supabase, build, {
    apply_id: applyRow.id,
    resources_destroyed: result.resources_destroyed,
  });

  // Reload the row to surface the latest state to the client.
  const finalRow = await loadLatestInfraApply(supabase, build.id);
  return NextResponse.json({
    status: 'destroyed',
    kind: 'infrastructure',
    build_id: build.id,
    apply: finalRow ? sanitizeInfraApplyForResponse(finalRow) : null,
  });
}
