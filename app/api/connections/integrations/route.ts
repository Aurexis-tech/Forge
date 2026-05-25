// Status + disconnect for GitHub / Vercel connections.
//
// Mirrors /api/connections/keys (which serves the BYOK Anthropic + E2B
// providers), but for the OAuth-style integrations. Same security shape:
// the token is NEVER returned, only the public metadata (login, scopes,
// timestamp) the UI needs to render a connected-state pill.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { deleteConnection } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';
import type { Connection, ConnectionProvider } from '@/lib/types';

export const runtime = 'nodejs';

const IntegrationProviderEnum = z.enum(['github', 'vercel']);
type IntegrationProvider = z.infer<typeof IntegrationProviderEnum>;

interface ProviderStatus {
  connected: boolean;
  account_login: string | null;
  scopes: string | null;
  connected_at: string | null;
}

interface StatusResponse {
  github: ProviderStatus;
  vercel: ProviderStatus;
}

async function authed() {
  try {
    return { user: await requireUser() };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return { error: 'not signed in', status: 401 };
    }
    throw err;
  }
}

// GET — per-provider status. NEVER includes the token.
export async function GET() {
  const r = await authed();
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('connections')
    .select('provider, account_login, scopes, created_at')
    .eq('user_id', r.user.id)
    .in('provider', ['github', 'vercel']);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Array<
    Pick<Connection, 'provider' | 'account_login' | 'scopes' | 'created_at'>
  >;
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  const body: StatusResponse = {
    github: shape(byProvider.get('github')),
    vercel: shape(byProvider.get('vercel')),
  };
  return NextResponse.json(body);
}

// DELETE — drop the connection. Audit-only metadata captured before the
// drop. The encrypted token is dropped at the DB layer; nothing recoverable
// is logged.
export async function DELETE(req: Request) {
  const r = await authed();
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });

  const url = new URL(req.url);
  const providerParam = url.searchParams.get('provider');
  const providerResult = IntegrationProviderEnum.safeParse(providerParam);
  if (!providerResult.success) {
    return NextResponse.json(
      { error: 'provider must be github or vercel' },
      { status: 400 },
    );
  }
  const provider: IntegrationProvider = providerResult.data;

  const supabase = getServerSupabase();
  const { data: existing } = await supabase
    .from('connections')
    .select('account_login')
    .eq('user_id', r.user.id)
    .eq('provider', provider)
    .maybeSingle();
  const wasLogin =
    (existing as { account_login: string | null } | null)?.account_login ?? null;

  try {
    await deleteConnection(supabase, r.user.id, provider satisfies ConnectionProvider);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'delete_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.' + provider + '_removed',
    actor: 'user',
    detail: { provider, account_login: wasLogin, user_id: r.user.id },
  });

  return NextResponse.json({ status: 'removed', provider });
}

function shape(
  row:
    | Pick<Connection, 'provider' | 'account_login' | 'scopes' | 'created_at'>
    | undefined,
): ProviderStatus {
  if (!row) {
    return {
      connected: false,
      account_login: null,
      scopes: null,
      connected_at: null,
    };
  }
  return {
    connected: true,
    account_login: row.account_login,
    scopes: row.scopes,
    connected_at: row.created_at,
  };
}
