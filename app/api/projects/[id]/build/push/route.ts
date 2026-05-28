import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireProjectOwnership, requireUser, UnauthorizedError } from '@/lib/auth';
import { assertAllowed, GovernanceError, governanceBlockResponse } from '@/lib/engine/governance/guard';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import {
  GitHubPushError,
  pushBuildToGitHub,
} from '@/lib/engine/integrations/github';
import { auditEngineError } from '@/lib/engine/observability/audit-engine-error';
import { getServerSupabase } from '@/lib/supabase';
import type { Build, BuildFile } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

// The route REQUIRES `authorized: true` in the body. The flag is the only
// in-flight expression of the user's in-the-moment consent — without it the
// route refuses regardless of cookies, sessions, or previous approvals.
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
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }
  const project = ownership.project;

  // Governance: kill switch + budget. Push itself doesn't burn LLM, but it
  // does fire third-party calls under the user's account.
  try {
    await assertAllowed({ user_id: user.id, project_id: projectId, projectedCostUsd: 0 });
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
          'request body must include { "authorized": true } — the user must explicitly approve the push',
      },
      { status: 403 },
    );
  }

  const supabase = getServerSupabase();

  const { data: builds } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1);
  const build = (builds?.[0] as Build | undefined) ?? null;
  if (!build) {
    return NextResponse.json({ error: 'project has no build' }, { status: 409 });
  }
  // Defence in depth — Phase 1 push only handles agent builds.
  // Phase 2 systems route through /api/projects/[id]/system/build/push;
  // Phase 3 software routes through /api/projects/[id]/software/build/push.
  if (build.kind === 'system') {
    return NextResponse.json(
      {
        error:
          "this is a system build (kind='system'). Use /api/projects/[id]/system/build/push for the system push.",
      },
      { status: 409 },
    );
  }
  if (build.kind === 'software') {
    return NextResponse.json(
      {
        error:
          "this is a software build (kind='software'). Use /api/projects/[id]/software/build/push for the software push.",
      },
      { status: 409 },
    );
  }
  if (build.kind && build.kind !== 'agent') {
    return NextResponse.json(
      {
        error:
          "this build has kind='" +
          build.kind +
          "' which has no push path in this phase.",
      },
      { status: 409 },
    );
  }
  // Allow retries from 'push_failed' so the user can re-approve the gate
  // after a transient error. NOT 'pushed' — that would clobber an existing
  // repo URL; the user should create a new project to push again.
  if (build.status !== 'tested' && build.status !== 'push_failed') {
    return NextResponse.json(
      {
        error:
          "build is in status '" +
          build.status +
          "'; only 'tested' (or 'push_failed' for retry) can be pushed to GitHub",
      },
      { status: 409 },
    );
  }

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

  // --- Files --------------------------------------------------------------
  const { data: filesData, error: filesErr } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  if (filesErr) {
    return NextResponse.json({ error: filesErr.message }, { status: 500 });
  }
  const files = (filesData ?? []) as BuildFile[];
  if (files.length === 0) {
    return NextResponse.json({ error: 'build has no files' }, { status: 422 });
  }

  // --- Audit the authorisation BEFORE acting ------------------------------
  await supabase.from('audit_log').insert({
    project_id: projectId,
    action: 'repo.create_authorized',
    actor: 'user',
    detail: {
      build_id: build.id,
      account_login: conn.row.account_login,
      files_count: files.length,
    },
  });

  await supabase.from('builds').update({ status: 'pushing' }).eq('id', build.id);

  // --- Push ---------------------------------------------------------------
  try {
    const result = await pushBuildToGitHub({
      token: conn.token,
      projectName: project.name,
      ownerLogin: conn.row.account_login,
      files,
    });

    await supabase
      .from('builds')
      .update({ status: 'pushed', repo_url: result.repo_url })
      .eq('id', build.id);

    await supabase.from('audit_log').insert({
      project_id: projectId,
      action: 'repo.created',
      actor: 'integration.github',
      detail: {
        build_id: build.id,
        repo_url: result.repo_url,
        repo_name: result.repo_name,
        owner: result.owner,
        private: true,
        default_branch: result.default_branch,
      },
    });
    await supabase.from('audit_log').insert({
      project_id: projectId,
      action: 'repo.push_completed',
      actor: 'integration.github',
      detail: {
        build_id: build.id,
        repo_url: result.repo_url,
        files_count: result.files_pushed,
        commit_sha: result.commit_sha,
      },
    });

    return NextResponse.json({
      status: 'pushed',
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
    await supabase
      .from('builds')
      .update({ status: 'push_failed' })
      .eq('id', build.id);
    // Enriched audit row with classified error category. Replaces the
    // hand-rolled audit_log insert above so the timeline sees the
    // category alongside the existing detail.
    await auditEngineError({
      supabase,
      projectId,
      action: 'repo.push_failed',
      err,
      actor: 'integration.github',
      extra: { build_id: build.id, error: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
