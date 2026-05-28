// Personal Access Token paste flow for GitHub. Sits alongside the OAuth
// flow at /api/connections/github/start — both end in the same
// upsertConnection call, so downstream code (push routes) treats them
// identically.
//
// SECURITY:
// - Token arrives over HTTPS in the request body, never in the URL.
// - It is NEVER logged.
// - It is NEVER returned in any response.
// - It is encrypted at rest via lib/crypto.ts before hitting Supabase.

import { NextResponse } from 'next/server';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { withRetry } from '@/lib/engine/retry';
import { upsertConnection } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

const BodySchema = z.object({
  token: z.string().trim().min(8).max(400),
});

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
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
      { error: 'token is required (paste a GitHub Personal Access Token)' },
      { status: 400 },
    );
  }
  const token = parsed.data.token;

  // Verify by calling users.getAuthenticated. This confirms the token is
  // valid before we persist anything, and gives us the login for display +
  // audit. Surface x-oauth-scopes so the user can sanity-check that 'repo'
  // is present.
  const octokit = new Octokit({ auth: token, userAgent: 'aurexis-forge' });
  let login = 'unknown';
  let scopes: string | null = null;
  try {
    // Retry transient GitHub blips (5xx/429/network). Bad-token
    // (401/403) is non-retriable — the loop exits on first attempt.
    const res = await withRetry(
      () => octokit.users.getAuthenticated(),
      { maxAttempts: 3, baseDelayMs: 500 },
    );
    login = res.data.login ?? 'unknown';
    const rawScopes = res.headers['x-oauth-scopes'];
    scopes = typeof rawScopes === 'string' && rawScopes.length > 0
      ? rawScopes
      : null;
  } catch (err) {
    // Octokit attaches a numeric `status` to its errors. Translate the
    // common ones to clean copy; never echo the raw token.
    const status = (err as { status?: number }).status;
    const message =
      status === 401
        ? 'token rejected by GitHub (invalid or revoked)'
        : status === 403
          ? 'token does not have permission to read the user'
          : 'token verification failed' + (status ? ' (HTTP ' + status + ')' : '');
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const supabase = getServerSupabase();
  try {
    await upsertConnection(supabase, {
      provider: 'github',
      accountLogin: login,
      token,
      scopes,
      userId: user.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'persist_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.github_linked',
    actor: 'user',
    detail: {
      account_login: login,
      scopes,
      auth_method: 'pat',
      user_id: user.id,
    },
  });

  return NextResponse.json({
    status: 'connected',
    account_login: login,
    scopes,
  });
}
