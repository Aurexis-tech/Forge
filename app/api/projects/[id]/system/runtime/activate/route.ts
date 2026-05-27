// POST /api/projects/[id]/system/runtime/activate
//
// Phase 2 (Systems) runtime activation — the LAST authorisation gate
// in the system pipeline. Mirrors the Phase 1 activate route shape
// (`{ authorized: true, cron, env?, mode?, max_run_ms? }`) but
// operates on kind='system' builds and inserts a kind='system'
// agent_runtimes row. REUSES the Phase 1 cron parser + AuthorizationGate
// + governance guard.
//
// AUTHORIZATION GATE — request body MUST include `{ "authorized": true }`.
// No cookie/session substitutes; the user explicitly approves THIS
// activation.
//
// SHARED COST CEILING (Phase 2 non-negotiable):
//   The activated runtime is gated by the SAME budget + kill switch
//   posture as Phase 1 — one orchestration run is ONE governed unit,
//   not N (the per-run guard inside the system scheduler enforces
//   this with projectedCostUsd derived from max_run_ms).
//
// Refuses if a system runtime already exists for this project in any
// non-stopped state — you must Stop the existing one first.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireProjectOwnership, requireUser, UnauthorizedError } from '@/lib/auth';
import {
  assertAllowed,
  GovernanceError,
  governanceBlockResponse,
} from '@/lib/engine/governance/guard';
import { audit } from '@/lib/engine/runtime/persistence';
import {
  aggregateSystemEnvRequired,
} from '@/lib/engine/system/integrations/persistence';
import {
  createSystemRuntime,
  loadSystemRuntimeContext,
  loadSystemRuntimeForProject,
} from '@/lib/engine/system/runtime/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

const BodySchema = z.object({
  authorized: z.literal(true),
  cron: z.string().trim().min(1).max(120),
  env: z.record(z.string().min(1), z.string().max(8000)).optional(),
  mode: z.enum(['schedule', 'always_on']).optional(),
  max_run_ms: z.number().int().min(5_000).max(240_000).optional(),
});

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }
  const ownership = await requireProjectOwnership(params.id, user);
  if ('error' in ownership) {
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }
  try {
    await assertAllowed({
      user_id: user.id,
      project_id: params.id,
      projectedCostUsd: 0,
    });
  } catch (err) {
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      return NextResponse.json(body, { status });
    }
    throw err;
  }

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
          'request body must include { "authorized": true, "cron": "*/5 * * * *", ... } — the user must explicitly approve activation',
      },
      { status: 403 },
    );
  }

  const supabase = getServerSupabase();
  const ctx = await loadSystemRuntimeContext(supabase, params.id);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { project, build, spec, plan } = ctx;

  // Refuse if a non-stopped system runtime already exists.
  const existing = await loadSystemRuntimeForProject(supabase, params.id);
  if (existing && existing.status !== 'stopped') {
    return NextResponse.json(
      {
        error:
          "a system runtime already exists for this project (status '" +
          existing.status +
          "'); stop it first to re-activate",
      },
      { status: 409 },
    );
  }

  // Pick the runtime mode. Default: 'schedule' when the SystemSpec
  // declares a schedule trigger, otherwise 'always_on' (the
  // orchestrator is reachable on-demand via the deploy URL even when
  // the runtime is in always_on; the cron tick still fires whatever
  // cadence the user requested).
  const mode: 'schedule' | 'always_on' =
    parsed.data.mode ??
    (spec.triggers.includes('schedule') ? 'schedule' : 'always_on');

  const envValues = parsed.data.env ?? {};
  // Aggregate env keys from the OrchestrationPlan (union across all
  // node-level suggested_tools) so the declared key list stays in sync
  // with what the system actually needs.
  const declaredKeys = aggregateSystemEnvRequired(plan).map((e) => e.key);
  const allKeys = Array.from(
    new Set([...declaredKeys, ...Object.keys(envValues)]),
  );

  // Audit the authorisation BEFORE acting — consent is recorded even
  // if a crash occurs mid-create.
  await audit(supabase, {
    projectId: project.id,
    action: 'system.runtime_activated',
    actor: 'user',
    detail: {
      build_id: build.id,
      mode,
      cron: parsed.data.cron,
      env_keys: allKeys,
      max_run_ms: parsed.data.max_run_ms ?? 60_000,
      nodes: plan.nodes.length,
    },
  });

  try {
    const created = await createSystemRuntime(supabase, {
      project,
      build,
      mode,
      scheduleCron: parsed.data.cron,
      envValues,
      envKeys: allKeys,
      maxRunMs: parsed.data.max_run_ms ?? 60_000,
    });
    return NextResponse.json({
      status: 'active',
      kind: 'system',
      runtime_id: created.id,
      next_run_at: created.next_run_at,
      mode: created.mode,
      cron: created.schedule_cron,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed to activate system runtime';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
