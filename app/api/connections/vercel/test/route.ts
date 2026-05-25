// Verify a previously-stored Vercel token without re-pasting it. Decrypts
// the stored token server-side, calls GET /v2/user with the Bearer token,
// reports pass/fail + the username/email.
//
// SECURITY: the decrypted token NEVER leaves this handler. The response
// only contains identity metadata.

import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

interface VercelUserResponse {
  user?: {
    username?: string;
    name?: string;
    email?: string;
  };
  username?: string;
  name?: string;
  email?: string;
  uid?: string;
}

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
  const loaded = await loadConnectionWithToken(supabase, 'vercel', user.id);
  if (!loaded) {
    return NextResponse.json(
      { ok: false, error: 'no vercel connection' },
      { status: 404 },
    );
  }

  try {
    const res = await fetch('https://api.vercel.com/v2/user', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + loaded.token,
        'user-agent': 'aurexis-forge',
      },
    });
    if (!res.ok) {
      const status = res.status;
      const message =
        status === 401
          ? 'token rejected by Vercel (invalid or revoked)'
          : status === 403
            ? 'token does not have permission to read the user'
            : 'vercel request failed (HTTP ' + status + ')';
      return NextResponse.json(
        { ok: false, provider: 'vercel', error: message },
        { status: 200 },
      );
    }
    const data = (await res.json()) as VercelUserResponse;
    const login =
      data.user?.username ??
      data.user?.name ??
      data.username ??
      data.name ??
      loaded.row.account_login ??
      'unknown';
    const email = data.user?.email ?? data.email ?? null;

    // Refresh the stored login so the UI reflects the current account.
    await supabase
      .from('connections')
      .update({ account_login: login })
      .eq('user_id', user.id)
      .eq('provider', 'vercel');

    return NextResponse.json({
      ok: true,
      provider: 'vercel',
      account_login: login,
      email,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'vercel request failed';
    return NextResponse.json(
      { ok: false, provider: 'vercel', error: msg },
      { status: 200 },
    );
  }
}
