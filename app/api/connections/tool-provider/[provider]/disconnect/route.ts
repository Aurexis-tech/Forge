// Disconnect an AGENT TOOL-PROVIDER key (user-initiated; the UI
// confirms before calling). Drops the encrypted connection row for
// the signed-in user. Nothing recoverable is logged.

import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { deleteConnection } from '@/lib/engine/integrations/connections';
import { listToolProviderConnections } from '@/lib/engine/tools';
import { getServerSupabase } from '@/lib/supabase';
import type { ConnectionProvider } from '@/lib/types';

export const runtime = 'nodejs';

interface RouteContext {
  params: { provider: string };
}

export async function POST(_req: Request, { params }: RouteContext) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  // Only allow disconnecting a KNOWN tool-provider (defence in depth —
  // this route never touches platform connections like github/vercel).
  const connection = listToolProviderConnections().find(
    (c) => c.provider === params.provider,
  );
  if (!connection) {
    return NextResponse.json(
      { error: 'unknown tool provider: ' + params.provider },
      { status: 404 },
    );
  }

  const supabase = getServerSupabase();
  try {
    await deleteConnection(
      supabase,
      user.id,
      connection.provider as ConnectionProvider,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'delete_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.tool_provider_removed',
    actor: 'user',
    detail: { provider: connection.provider, user_id: user.id },
  });

  return NextResponse.json({ status: 'removed', provider: connection.provider });
}
