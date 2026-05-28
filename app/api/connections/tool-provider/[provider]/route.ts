// Verify + persist an AGENT TOOL-PROVIDER key (e.g. Brave Search for
// web_search). Mirrors the GitHub/Vercel/Supabase PAT routes:
//   - key arrives in the request BODY (never a URL param),
//   - verified read-only against the provider's declared verify shape
//     BEFORE persisting (verify-fail → 422, nothing stored),
//   - stored ENCRYPTED via the existing connections store (lib/crypto),
//   - NEVER logged, NEVER echoed back. Response carries { connected:true }
//     only.
//
// The stored key is later resolved at deploy time and wired into the
// DEPLOYED AGENT's env (SERVER-ONLY). The Forge itself never calls the
// provider API.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { upsertConnection } from '@/lib/engine/integrations/connections';
import {
  listToolProviderConnections,
  verifyProviderKey,
} from '@/lib/engine/tools';
import { getServerSupabase } from '@/lib/supabase';
import type { ConnectionProvider } from '@/lib/types';

export const runtime = 'nodejs';

const BodySchema = z.object({
  key: z.string().trim().min(8).max(2000),
});

interface RouteContext {
  params: { provider: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  // Look the provider up in the registry-derived list. Unknown → 404.
  const connection = listToolProviderConnections().find(
    (c) => c.provider === params.provider,
  );
  if (!connection) {
    return NextResponse.json(
      { error: 'unknown tool provider: ' + params.provider },
      { status: 404 },
    );
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
      { error: 'a non-empty `key` is required in the request body' },
      { status: 400 },
    );
  }
  const key = parsed.data.key;

  // Verify BEFORE persisting. Verify-fail → 422, nothing stored.
  const result = await verifyProviderKey(connection, key);
  if (!result.ok) {
    return NextResponse.json(
      {
        reason: 'verify_failed',
        provider: connection.provider,
        status: result.status ?? null,
        error:
          connection.label +
          ' rejected the key' +
          (result.status ? ' (HTTP ' + result.status + ')' : '') +
          '. Check the key and try again.',
      },
      { status: 422 },
    );
  }

  // Persist encrypted via the shared connection store. account_login is
  // a display label only (the provider label) — no token, no identity.
  const supabase = getServerSupabase();
  try {
    await upsertConnection(supabase, {
      provider: connection.provider as ConnectionProvider,
      accountLogin: connection.label,
      token: key,
      scopes: null,
      userId: user.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'persist_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Audit — metadata only, NEVER the key.
  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.tool_provider_linked',
    actor: 'user',
    detail: {
      provider: connection.provider,
      env_key: connection.env_key,
      user_id: user.id,
    },
  });

  return NextResponse.json({ connected: true, provider: connection.provider });
}
