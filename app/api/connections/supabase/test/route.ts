// Verify a previously-stored Supabase Management token without
// re-pasting it. Decrypts the stored token server-side, runs a
// READ-ONLY GET /v1/organizations against the Management API,
// reports pass/fail + the org name on success. NEVER creates or
// modifies a Supabase project.
//
// SECURITY: the decrypted token NEVER leaves this handler. The
// response only contains identity metadata.

import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

interface SupabaseOrganization {
  id?: string;
  name?: string;
  slug?: string;
}

const SUPABASE_MANAGEMENT_API = 'https://api.supabase.com';

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
  const loaded = await loadConnectionWithToken(supabase, 'supabase', user.id);
  if (!loaded) {
    return NextResponse.json(
      { ok: false, error: 'no supabase connection' },
      { status: 404 },
    );
  }

  try {
    const res = await fetch(SUPABASE_MANAGEMENT_API + '/v1/organizations', {
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
          ? 'token rejected by Supabase (invalid or revoked)'
          : status === 403
            ? 'token does not have permission to list organisations'
            : 'supabase request failed (HTTP ' + status + ')';
      return NextResponse.json(
        { ok: false, provider: 'supabase', error: message },
        { status: 200 },
      );
    }
    const orgs = (await res.json().catch(() => [])) as SupabaseOrganization[];
    const orgName =
      orgs[0]?.name ??
      orgs[0]?.slug ??
      orgs[0]?.id ??
      loaded.row.account_login ??
      'unknown';

    // Refresh the stored login so the UI reflects the current org.
    await supabase
      .from('connections')
      .update({ account_login: orgName })
      .eq('user_id', user.id)
      .eq('provider', 'supabase');

    return NextResponse.json({
      ok: true,
      provider: 'supabase',
      account_login: orgName,
      org_count: orgs.length,
    });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'supabase request failed';
    return NextResponse.json(
      { ok: false, provider: 'supabase', error: msg },
      { status: 200 },
    );
  }
}
