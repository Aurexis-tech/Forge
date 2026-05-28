// Status for AGENT TOOL-PROVIDER connections (e.g. Brave Search for
// web_search). These are keys the user's DEPLOYED AGENTS use — NOT
// creds the Forge itself uses. Registry-driven: the panel set comes
// from listToolProviderConnections(), so a new provider-backed tool
// shows up automatically.
//
// GET — per-provider status for the signed-in user. NEVER returns a
// token. The panel metadata (label, setup_url, env_key) is public,
// registry-derived config; only `connected` + `connected_at` are
// user-specific.

import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { listToolProviderConnections } from '@/lib/engine/tools';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

interface ToolProviderStatus {
  provider: string;
  label: string;
  env_key: string;
  setup_url: string | null;
  connected: boolean;
  connected_at: string | null;
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  const connections = listToolProviderConnections();
  if (connections.length === 0) {
    return NextResponse.json({ providers: [] as ToolProviderStatus[] });
  }

  const supabase = getServerSupabase();
  const providerIds = connections.map((c) => c.provider);
  const { data, error } = await supabase
    .from('connections')
    .select('provider, created_at')
    .eq('user_id', user.id)
    .in('provider', providerIds);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Array<{ provider: string; created_at: string }>;
  const connectedAt = new Map(rows.map((r) => [r.provider, r.created_at]));

  const providers: ToolProviderStatus[] = connections.map((c) => ({
    provider: c.provider,
    label: c.label,
    env_key: c.env_key,
    setup_url: c.setup_url ?? null,
    connected: connectedAt.has(c.provider),
    connected_at: connectedAt.get(c.provider) ?? null,
  }));

  return NextResponse.json({ providers });
}
