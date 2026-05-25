// Personal Access Token fallback for connecting Vercel when an OAuth
// integration isn't configured. The user pastes a token from
// https://vercel.com/account/tokens; we verify it by calling /v2/user, then
// encrypt + store it exactly like the OAuth path.
//
// SECURITY:
// - The token arrives over HTTPS in the request body, never in the URL.
// - It is NEVER logged.
// - It is NEVER returned in any response.
// - It is encrypted at rest via lib/crypto.ts before hitting Supabase.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { upsertConnection } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

const BodySchema = z.object({
  token: z.string().trim().min(8).max(400),
});

interface VercelUserResponse {
  user?: { username?: string; name?: string };
  username?: string;
  uid?: string;
}

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
      { error: 'token is required (paste a Vercel Personal Access Token)' },
      { status: 400 },
    );
  }
  const token = parsed.data.token;

  // Verify the token by calling /v2/user. This confirms the token is valid
  // before we persist anything, and gives us a username for display.
  let login = 'unknown';
  try {
    const res = await fetch('https://api.vercel.com/v2/user', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + token,
        'user-agent': 'aurexis-forge',
      },
    });
    if (!res.ok) {
      // Translate common failure shapes to a clean message — never echo the
      // token back.
      const status = res.status;
      const message =
        status === 401
          ? 'token rejected by Vercel (invalid or revoked)'
          : status === 403
            ? 'token does not have permission to read the user'
            : 'token verification failed (HTTP ' + status + ')';
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const data = (await res.json()) as VercelUserResponse;
    login =
      data.user?.username ??
      data.user?.name ??
      data.username ??
      'unknown';
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'verify_failed';
    return NextResponse.json(
      { error: 'failed to reach Vercel to verify token: ' + msg },
      { status: 502 },
    );
  }

  const supabase = getServerSupabase();
  try {
    await upsertConnection(supabase, {
      provider: 'vercel',
      accountLogin: login,
      token,
      scopes: 'pat',
      userId: user.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'persist_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.vercel_linked',
    actor: 'user',
    detail: {
      account_login: login,
      auth_method: 'pat',
      user_id: user.id,
    },
  });

  return NextResponse.json({ status: 'connected', account_login: login });
}
