// Activate a 24/7 runtime — third human authorisation gate.
//
// Requires:
//   - build.status === 'pushed'
//   - plan.runtime_impl === 'always_on' OR spec.trigger === 'schedule'
//   - body { authorized: true, cron, env, mode?, max_run_ms? }
//
// Refuses if a runtime already exists for this project in a non-stopped
// state — you must Stop the existing one first.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireProjectOwnership, requireUser, UnauthorizedError } from '@/lib/auth';
import {
  assertAllowed,
  GovernanceError,
  governanceBlockResponse,
} from '@/lib/engine/governance/guard';
import {
  audit,
  createRuntime,
  loadRuntimeContext,
  loadRuntimeForProject,
} from '@/lib/engine/runtime/persistence';
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
          'request body must include { "authorized": true, "cron": "*/5 * * * *", ... }',
      },
      { status: 403 },
    );
  }

  const supabase = getServerSupabase();
  const ctx = await loadRuntimeContext(supabase, params.id);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { project, build, spec, plan } = ctx;

  // Gate: must be a runtime-mode build.
  const isRuntimeMode =
    plan.runtime_impl === 'always_on' || spec.trigger === 'schedule';
  if (!isRuntimeMode) {
    return NextResponse.json(
      {
        error:
          'this build is on-demand; activate it via the deploy step, not the runtime step',
      },
      { status: 409 },
    );
  }
  if (build.status !== 'pushed') {
    return NextResponse.json(
      {
        error:
          "build is in status '" +
          build.status +
          "'; activate requires 'pushed'",
      },
      { status: 409 },
    );
  }

  const existing = await loadRuntimeForProject(supabase, params.id);
  if (existing && existing.status !== 'stopped') {
    return NextResponse.json(
      {
        error:
          "a runtime already exists for this project (status '" +
          existing.status +
          "'); stop it first to re-activate",
      },
      { status: 409 },
    );
  }

  const mode: 'schedule' | 'always_on' =
    parsed.data.mode ?? (spec.trigger === 'schedule' ? 'schedule' : 'always_on');
  const envValues = parsed.data.env ?? {};
  const declaredKeys = plan.env_required.map((e) => e.key);
  const allKeys = Array.from(new Set([...declaredKeys, ...Object.keys(envValues)]));

  // Audit the authorisation BEFORE acting so consent is recorded even if a
  // crash occurs mid-create.
  await audit(supabase, {
    projectId: project.id,
    action: 'runtime.activated',
    actor: 'user',
    detail: {
      build_id: build.id,
      mode,
      cron: parsed.data.cron,
      env_keys: allKeys,
      max_run_ms: parsed.data.max_run_ms ?? 60_000,
    },
  });

  try {
    const created = await createRuntime(supabase, {
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
      runtime_id: created.id,
      next_run_at: created.next_run_at,
      mode: created.mode,
      cron: created.schedule_cron,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed to activate runtime';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
