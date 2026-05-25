// Begin the Vercel OAuth integration flow.
//
// Vercel "integrations" are the OAuth equivalent: the user installs ours on
// their account / a team, then Vercel redirects back to our callback with a
// code we exchange for an access token.
//
// If VERCEL_OAUTH_CLIENT_ID is unset the UI falls back to a PAT paste form
// (see /api/connections/vercel/pat). This route returns 501 in that case so
// the UI can detect the missing configuration.

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const STATE_COOKIE = 'forge_vc_state';
const RETURN_COOKIE = 'forge_vc_return';

export async function GET(req: Request) {
  const clientId = process.env.VERCEL_OAUTH_CLIENT_ID;
  const slug = process.env.VERCEL_INTEGRATION_SLUG;
  if (!clientId || !slug) {
    return NextResponse.json(
      {
        error:
          'Vercel OAuth integration is not configured. Use the Personal Access Token flow instead.',
      },
      { status: 501 },
    );
  }

  const url = new URL(req.url);
  const baseUrl = (process.env.APP_BASE_URL ?? url.origin).replace(/\/+$/, '');
  const redirectUri = baseUrl + '/api/connections/vercel/callback';

  const requested = url.searchParams.get('return_to') ?? '/projects';
  const returnTo =
    requested.startsWith('/') && !requested.startsWith('//')
      ? requested
      : '/projects';

  const state = randomBytes(24).toString('base64url');

  const install = new URL('https://vercel.com/integrations/' + slug + '/new');
  install.searchParams.set('next', redirectUri);
  install.searchParams.set('state', state);

  const response = NextResponse.redirect(install.toString());
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
