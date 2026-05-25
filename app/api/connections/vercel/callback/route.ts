// Complete the Vercel OAuth integration flow.
//
// 1. Verify the state cookie (constant-time) against the state query.
// 2. Exchange the code for an access token at Vercel's OAuth endpoint.
// 3. Fetch the authenticated user's username for display.
// 4. Encrypt + upsert into `connections` under provider='vercel'.
// 5. Audit-log the link and redirect back.

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { safeEqual } from '@/lib/crypto';
import { upsertConnection } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

const STATE_COOKIE = 'forge_vc_state';
const RETURN_COOKIE = 'forge_vc_return';

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  installation_id?: string;
  user_id?: string;
  team_id?: string | null;
  error?: string;
}

interface VercelUser {
  user?: { username?: string; name?: string };
  username?: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const ghError = url.searchParams.get('error');

  const jar = cookies();
  const stateCookie = jar.get(STATE_COOKIE)?.value;
  const returnTo = jar.get(RETURN_COOKIE)?.value || '/projects';

  const finish = (response: NextResponse) => {
    response.cookies.delete(STATE_COOKIE);
    response.cookies.delete(RETURN_COOKIE);
    return response;
  };

  if (ghError) {
    return finish(redirectWithFlag(req, returnTo, 'vercel_error', ghError));
  }
  if (!code || !stateParam) {
    return finish(
      redirectWithFlag(req, returnTo, 'vercel_error', 'missing_code'),
    );
  }
  if (!stateCookie || !safeEqual(stateCookie, stateParam)) {
    return finish(
      redirectWithFlag(req, returnTo, 'vercel_error', 'state_mismatch'),
    );
  }

  const clientId = process.env.VERCEL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.VERCEL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return finish(
      redirectWithFlag(req, returnTo, 'vercel_error', 'app_not_configured'),
    );
  }

  const baseUrl = (process.env.APP_BASE_URL ?? url.origin).replace(/\/+$/, '');
  const redirectUri = baseUrl + '/api/connections/vercel/callback';

  let token: string;
  let teamId: string | null = null;
  try {
    const tokenRes = await fetch('https://api.vercel.com/v2/oauth/access_token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'aurexis-forge',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const payload = (await tokenRes.json()) as TokenResponse;
    if (!payload.access_token) {
      return finish(
        redirectWithFlag(
          req,
          returnTo,
          'vercel_error',
          payload.error ?? 'no_access_token',
        ),
      );
    }
    token = payload.access_token;
    teamId = payload.team_id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'token_exchange_failed';
    return finish(redirectWithFlag(req, returnTo, 'vercel_error', msg));
  }

  // Look up the username for the connection label. Best-effort.
  let login = teamId ? 'team:' + teamId : 'unknown';
  try {
    const userRes = await fetch('https://api.vercel.com/v2/user', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + token,
        'user-agent': 'aurexis-forge',
      },
    });
    if (userRes.ok) {
      const user = (await userRes.json()) as VercelUser;
      const name = user.user?.username ?? user.user?.name ?? user.username;
      if (name) login = name;
    }
  } catch {
    // Login is informational only.
  }

  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return finish(redirectWithFlag(req, '/sign-in', 'vercel_error', 'not_signed_in'));
    }
    throw err;
  }

  const supabase = getServerSupabase();
  try {
    // Store team_id alongside scopes so the deploy route can target it.
    await upsertConnection(supabase, {
      provider: 'vercel',
      accountLogin: login,
      token,
      scopes: teamId ? 'team:' + teamId : 'user',
      userId: user.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'persist_failed';
    return finish(redirectWithFlag(req, returnTo, 'vercel_error', msg));
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.vercel_linked',
    actor: 'user',
    detail: {
      account_login: login,
      team_id: teamId,
      auth_method: 'oauth',
      user_id: user.id,
    },
  });

  return finish(redirectWithFlag(req, returnTo, 'vercel_connected', login));
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
