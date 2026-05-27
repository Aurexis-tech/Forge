// POST /api/projects/[id]/software/runtime/activate
//
// Phase 3-6 (Software) go-live gate — the final authorisation gate
// in the software pipeline. Mirrors the Phase 1/2 activate routes'
// shape but is lighter: software runtimes have no schedule and no
// env (the env was wired into Vercel during P3-5b). Activating a
// software runtime just persists the user's authorisation and flips
// the build to 'running'.
//
// AUTHORIZATION GATE — request body MUST include `{ "authorized": true }`.
// No cookie/session substitutes; the user explicitly approves THIS
// go-live.
//
// KILL SWITCH — the request flows through `projectRouteGuard` which
// calls `assertAllowed`. An active kill switch in the applicable
// scope (global / user / project) blocks activation with the
// standard `governance:killed` response. Clearing the switch
// restores go-live.
//
// Refuses if a non-stopped software runtime already exists — the
// user must stop the existing one before re-activating (via the
// offline route).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireProjectOwnership,
  requireUser,
  UnauthorizedError,
} from '@/lib/auth';
import {
  assertAllowed,
  GovernanceError,
  governanceBlockResponse,
} from '@/lib/engine/governance/guard';
import {
  createSoftwareRuntime,
  loadDeployedSoftwareBuildForActivate,
  loadSoftwareRuntimeForProject,
  logSoftwareRuntimeActivated,
  logSoftwareRuntimeAuthorized,
} from '@/lib/engine/software/runtime/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

const BodySchema = z.object({
  authorized: z.literal(true),
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
    return NextResponse.json(
      { error: ownership.error },
      { status: ownership.status },
    );
  }

  // Governance: kill switch + budget headroom. Go-live itself spends
  // zero LLM/sandbox compute, but a budget block while live still
  // matters; the guard fires both checks.
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
          'request body must include { "authorized": true } — the user must explicitly approve marking the app live',
      },
      { status: 403 },
    );
  }

  const supabase = getServerSupabase();
  const ctx = await loadDeployedSoftwareBuildForActivate(supabase, params.id);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { project, build } = ctx;

  // Refuse if a non-stopped software runtime already exists.
  const existing = await loadSoftwareRuntimeForProject(supabase, params.id);
  if (existing && existing.status !== 'stopped') {
    return NextResponse.json(
      {
        error:
          "a software runtime already exists for this project (status '" +
          existing.status +
          "'); take it offline first to re-activate",
      },
      { status: 409 },
    );
  }

  // Audit the authorisation BEFORE acting so consent is recorded
  // even if a crash occurs mid-create.
  await logSoftwareRuntimeAuthorized(supabase, build);

  try {
    const created = await createSoftwareRuntime(supabase, {
      project,
      build,
    });
    await logSoftwareRuntimeActivated(supabase, build, created.id);
    return NextResponse.json({
      status: 'active',
      kind: 'software',
      runtime_id: created.id,
      deploy_url: build.deploy_url,
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'failed to activate software runtime';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
