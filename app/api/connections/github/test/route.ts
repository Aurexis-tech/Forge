// Verify a previously-stored GitHub token without re-pasting it. Decrypts
// the stored token server-side, runs Octokit.users.getAuthenticated(),
// reports pass/fail + the login + scopes, and refreshes the connection's
// stored scopes if GitHub returned something new.
//
// SECURITY: the decrypted token NEVER leaves this handler. The response
// only contains the login (already in the DB) and the scopes string.

import { NextResponse } from 'next/server';
import { Octokit } from '@octokit/rest';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  const supabase = getServerSupabase();
  const loaded = await loadConnectionWithToken(supabase, 'github', user.id);
  if (!loaded) {
    return NextResponse.json(
      { ok: false, error: 'no github connection' },
      { status: 404 },
    );
  }

  const octokit = new Octokit({ auth: loaded.token, userAgent: 'aurexis-forge' });
  try {
    const res = await octokit.users.getAuthenticated();
    const login = res.data.login ?? loaded.row.account_login ?? 'unknown';
    const rawScopes = res.headers['x-oauth-scopes'];
    const scopes =
      typeof rawScopes === 'string' && rawScopes.length > 0 ? rawScopes : null;

    // Best-effort: keep the stored scopes in sync. We DON'T re-encrypt the
    // token (we never had the plaintext outside this handler's scope, and
    // we don't want to). Just patch the metadata columns.
    await supabase
      .from('connections')
      .update({
        account_login: login,
        scopes: scopes ?? loaded.row.scopes,
      })
      .eq('user_id', user.id)
      .eq('provider', 'github');

    return NextResponse.json({
      ok: true,
      provider: 'github',
      account_login: login,
      scopes,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message =
      status === 401
        ? 'token rejected by GitHub (invalid or revoked)'
        : status === 403
          ? 'token does not have permission to read the user'
          : err instanceof Error
            ? err.message
            : 'github request failed';
    return NextResponse.json(
      { ok: false, provider: 'github', error: message },
      { status: 200 },
    );
  }
}
