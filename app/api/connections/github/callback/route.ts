// Complete the GitHub OAuth flow.
//
//   1. Verify the state cookie matches the state query param (constant-time).
//   2. Exchange the code for an access token via GitHub's token endpoint.
//   3. Fetch the authenticated user's login to label the connection.
//   4. Encrypt + upsert into `connections` (under FORGE_USER_ID).
//   5. Audit-log the link and redirect back to the originating page.
//
// Tokens NEVER touch a response body, a URL, or a log line.

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { safeEqual } from '@/lib/crypto';
import { upsertConnection } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

const STATE_COOKIE = 'forge_gh_state';
const RETURN_COOKIE = 'forge_gh_return';

interface TokenResponse {
  access_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  login?: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const ghError = url.searchParams.get('error');

  const jar = cookies();
  const stateCookie = jar.get(STATE_COOKIE)?.value;
  const returnTo = jar.get(RETURN_COOKIE)?.value || '/projects';

  // Clean up the cookies regardless of outcome.
  const finish = (response: NextResponse) => {
    response.cookies.delete(STATE_COOKIE);
    response.cookies.delete(RETURN_COOKIE);
    return response;
  };

  if (ghError) {
    return finish(redirectWithFlag(req, returnTo, 'github_error', ghError));
  }
  if (!code || !stateParam) {
    return finish(
      redirectWithFlag(req, returnTo, 'github_error', 'missing_code'),
    );
  }
  if (!stateCookie || !safeEqual(stateCookie, stateParam)) {
    return finish(
      redirectWithFlag(req, returnTo, 'github_error', 'state_mismatch'),
    );
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return finish(
      redirectWithFlag(req, returnTo, 'github_error', 'app_not_configured'),
    );
  }

  // Exchange the code for an access token.
  const baseUrl = (process.env.APP_BASE_URL ?? url.origin).replace(/\/+$/, '');
  const redirectUri = baseUrl + '/api/connections/github/callback';

  let token: string;
  let scopes: string | null = null;
  try {
    const tokenRes = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'aurexis-forge',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      },
    );
    const payload = (await tokenRes.json()) as TokenResponse;
    if (!payload.access_token) {
      return finish(
        redirectWithFlag(
          req,
          returnTo,
          'github_error',
          payload.error ?? 'no_access_token',
        ),
      );
    }
    token = payload.access_token;
    scopes = payload.scope ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'token_exchange_failed';
    return finish(redirectWithFlag(req, returnTo, 'github_error', msg));
  }

  // Look up the authenticated user's login for display + audit. We do NOT
  // store anything beyond the login + token.
  let login = 'unknown';
  try {
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'user-agent': 'aurexis-forge',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (userRes.ok) {
      const user = (await userRes.json()) as GitHubUser;
      if (user.login) login = user.login;
    }
  } catch {
    // Login is informational; missing it shouldn't block the connection.
  }

  // The connection is being stored against the authenticated user. The
  // OAuth callback is in the middleware's OPEN_PREFIXES, so we have to
  // resolve the user ourselves here.
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return finish(redirectWithFlag(req, '/sign-in', 'github_error', 'not_signed_in'));
    }
    throw err;
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
    return finish(redirectWithFlag(req, returnTo, 'github_error', msg));
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.github_linked',
    actor: 'user',
    detail: { account_login: login, scopes, user_id: user.id },
  });

  return finish(redirectWithFlag(req, returnTo, 'github_connected', login));
}

function redirectWithFlag(
  req: Request,
  returnTo: string,
  key: string,
  value: string,
): NextResponse {
  const url = new URL(req.url);
  const base = (process.env.APP_BASE_URL ?? url.origin).replace(/\/+$/, '');
  const target = new URL(returnTo.startsWith('/') ? returnTo : '/projects', base);
  target.searchParams.set(key, value);
  return NextResponse.redirect(target.toString());
}
