// POST /api/projects/[id]/software/build/push
//
// Phase 3-5b (Software) push — creates a private GitHub repo and
// pushes the Next.js + Supabase app bundle (every file under
// build_files) as one initial commit. REUSES the Phase 1
// `pushBuildToGitHub` integration AS-IS; only the loader, the
// kind='software' status flips, and the audit actions are
// software-specific.
//
// AUTHORIZATION GATE — the request body MUST include
// `{ "authorized": true }`. No previous approval, cookie, or session
// state substitutes — the user must explicitly approve THIS push.
//
// A software build STOPS after deploy in this phase. There's no
// software runtime activation; the Phase 1/2 push loaders 409 a
// software build with the explicit "use the software route" hint as
// defence in depth.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireProjectOwnership, requireUser, UnauthorizedError } from '@/lib/auth';
import {
  assertAllowed,
  GovernanceError,
  governanceBlockResponse,
} from '@/lib/engine/governance/guard';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import {
  GitHubPushError,
  pushBuildToGitHub,
} from '@/lib/engine/integrations/github';
import {
  loadProvisionedSoftwareBuildForPush,
  logSoftwarePushAuthorized,
  logSoftwarePushFailed,
  logSoftwarePushed,
  markSoftwareBuildPushFailed,
  markSoftwareBuildPushed,
  markSoftwareBuildPushing,
} from '@/lib/engine/software/integrations/persistence';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
// Same ceiling as the Phase 1 + 2 push routes — Git push is bounded
// by repo size + GitHub API call latency.
export const maxDuration = 300;

const BodySchema = z.object({
  authorized: z.literal(true),
});

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;

  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  const ownership = await requireProjectOwnership(projectId, user);
  if ('error' in ownership) {
    return NextResponse.json(
      { error: ownership.error },
      { status: ownership.status },
    );
  }
  const project = ownership.project;

  try {
    await assertAllowed({
      user_id: user.id,
      project_id: projectId,
      projectedCostUsd: 0,
    });
  } catch (err) {
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      return NextResponse.json(body, { status });
    }
    throw err;
  }

  // Explicit, in-the-moment authorisation. The route refuses without
  // it — defence in depth even when the UI's gate is correctly mounted.
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
          'request body must include { "authorized": true } — the user must explicitly approve the software push',
      },
      { status: 403 },
    );
  }

  const supabase = getServerSupabase();

  const guard = await loadProvisionedSoftwareBuildForPush(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { build, files } = guard;

  // --- Connection ---------------------------------------------------------
  const conn = await loadConnectionWithToken(supabase, 'github', user.id);
  if (!conn) {
    return NextResponse.json(
      { error: 'GitHub is not connected; complete the OAuth flow first' },
      { status: 412 },
    );
  }
  if (!conn.row.account_login) {
    return NextResponse.json(
      { error: 'GitHub connection is missing account_login; reconnect' },
      { status: 412 },
    );
  }

  // --- Audit the authorisation BEFORE acting ------------------------------
  await logSoftwarePushAuthorized(
    supabase,
    build,
    conn.row.account_login,
    files.length,
  );
  await markSoftwareBuildPushing(supabase, build.id);

  // --- Push ---------------------------------------------------------------
  try {
    const result = await pushBuildToGitHub({
      token: conn.token,
      projectName: project.name,
      ownerLogin: conn.row.account_login,
      files,
    });

    await markSoftwareBuildPushed(supabase, build.id, result.repo_url);
    await logSoftwarePushed(supabase, build, {
      repo_url: result.repo_url,
      repo_name: result.repo_name,
      owner: result.owner,
      commit_sha: result.commit_sha,
      files_pushed: result.files_pushed,
      default_branch: result.default_branch,
    });

    return NextResponse.json({
      status: 'pushed',
      kind: 'software',
      repo_url: result.repo_url,
      repo_name: result.repo_name,
      owner: result.owner,
      commit_sha: result.commit_sha,
      files_pushed: result.files_pushed,
    });
  } catch (err) {
    const message =
      err instanceof GitHubPushError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'unknown push error';
    await markSoftwareBuildPushFailed(supabase, build.id);
    await logSoftwarePushFailed(supabase, build, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
