// Begin the GitHub OAuth flow.
//
// 1. Generate a random state token; stash it in an httpOnly cookie.
// 2. Optionally remember the page the user came from so we can land them
//    back there after the callback.
// 3. Redirect to GitHub's authorize endpoint with our client_id + state.
//
// We deliberately keep the cookie scope tight: short max-age, httpOnly,
// sameSite='lax' (required so it survives the redirect back from GitHub),
// secure in production.

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const STATE_COOKIE = 'forge_gh_state';
const RETURN_COOKIE = 'forge_gh_return';

export async function GET(req: Request) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'GITHUB_OAUTH_CLIENT_ID is not configured' },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const baseUrl = (process.env.APP_BASE_URL ?? url.origin).replace(/\/+$/, '');
  const redirectUri = baseUrl + '/api/connections/github/callback';

  const requested = url.searchParams.get('return_to') ?? '/projects';
  // Refuse open-redirect inputs — only allow same-origin paths.
  const returnTo = requested.startsWith('/') && !requested.startsWith('//')
    ? requested
    : '/projects';

  const state = randomBytes(24).toString('base64url');

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', 'repo');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'true');

  const response = NextResponse.redirect(authorize.toString());
  const isProd = process.env.NODE_ENV === 'production';

  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge: 10 * 60,
  });
  response.cookies.set(RETURN_COOKIE, returnTo, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge: 10 * 60,
  });

  return response;
}
