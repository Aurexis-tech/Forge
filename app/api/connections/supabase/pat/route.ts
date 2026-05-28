// Personal Access Token paste flow for Supabase Management. Mirrors
// /api/connections/github/pat exactly — token in the body (never URL),
// verified read-only against the Management API before persisting,
// encrypted at rest, NEVER logged, NEVER returned.
//
// This is the credential the 'managed' DB provisioning path uses
// (lib/engine/software/db/managed.ts) to create a fresh Supabase
// project on the user's account. The BYO path does NOT need this
// connection — that path takes URL + anon + service-role directly
// from the user.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { upsertConnection } from '@/lib/engine/integrations/connections';
import { withRetry } from '@/lib/engine/retry';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

// Optional context the UI may collect alongside the token — surfaced
// to the user in the connected-state pill. Never load-bearing; the
// downstream provisioning route reads org_id from a different source.
const BodySchema = z.object({
  token: z.string().trim().min(8).max(400),
  org_label: z.string().trim().min(1).max(120).optional(),
});

interface SupabaseOrganization {
  id?: string;
  name?: string;
  slug?: string;
}

const SUPABASE_MANAGEMENT_API = 'https://api.supabase.com';

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
      {
        error:
          'token is required (paste a Supabase Personal Access Token from supabase.com → Account → Access Tokens)',
      },
      { status: 400 },
    );
  }
  const token = parsed.data.token;

  // Verify by listing the user's organisations — read-only, the
  // cheapest call that proves the token is a valid Management PAT.
  // We DO NOT create / modify / delete anything here.
  let accountLogin = 'unknown';
  try {
    // Retry transient Supabase Management blips (5xx/429/network).
    const res = await withRetry(
      () =>
        fetch(SUPABASE_MANAGEMENT_API + '/v1/organizations', {
          headers: {
            accept: 'application/json',
            authorization: 'Bearer ' + token,
            'user-agent': 'aurexis-forge',
          },
        }),
      { maxAttempts: 3, baseDelayMs: 500 },
    );
    if (!res.ok) {
      const message = mapAuthError(res.status, 'Supabase Management');
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const orgs = (await res.json().catch(() => [])) as SupabaseOrganization[];
    // The first org's name (or slug) becomes the display login. If
    // the user supplied an explicit label, that wins — they may have
    // multiple orgs and prefer to disambiguate.
    accountLogin =
      parsed.data.org_label ??
      orgs[0]?.name ??
      orgs[0]?.slug ??
      orgs[0]?.id ??
      'unknown';
  } catch (err) {
    return NextResponse.json(
      {
        error:
          'supabase verification failed: ' +
          (err instanceof Error ? err.message : 'network error'),
      },
      { status: 400 },
    );
  }

  const supabase = getServerSupabase();
  try {
    await upsertConnection(supabase, {
      provider: 'supabase',
      accountLogin,
      token,
      scopes: null,
      userId: user.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'persist_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.supabase_linked',
    actor: 'user',
    detail: {
      account_login: accountLogin,
      auth_method: 'pat',
      user_id: user.id,
    },
  });

  return NextResponse.json({
    status: 'connected',
    provider: 'supabase',
    account_login: accountLogin,
  });
}

function mapAuthError(status: number, providerLabel: string): string {
  if (status === 401)
    return 'token rejected by ' + providerLabel + ' (invalid or revoked)';
  if (status === 403)
    return (
      'token does not have permission to read the account on ' + providerLabel
    );
  return providerLabel + ' verification failed (HTTP ' + status + ')';
}
