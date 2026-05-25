// BYOK key management — paste / replace / remove the user's Anthropic
// and E2B keys.
//
// SECURITY:
// - Keys arrive over HTTPS in the request body, never in a URL.
// - They are NEVER logged, NEVER echoed back, NEVER returned in any
//   response (we return only last4 + a "connected" flag).
// - Storage goes through lib/crypto.encryptSecret before hitting Supabase.
// - We tolerate validation network failures so a flaky provider doesn't
//   block the user from saving a (probably valid) key.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import {
  deleteConnection,
  upsertConnection,
} from '@/lib/engine/integrations/connections';
import {
  last4,
  validateAnthropicKey,
  validateE2BKey,
} from '@/lib/engine/keys';
import { getServerSupabase } from '@/lib/supabase';
import type { ByokProvider, Connection } from '@/lib/types';

export const runtime = 'nodejs';

const ProviderEnum = z.enum(['anthropic', 'e2b']);

const PostBodySchema = z.object({
  provider: ProviderEnum,
  key: z.string().trim().min(8).max(500),
});

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

// GET — return per-provider status. NEVER includes the key itself.
export async function GET() {
  const r = await authed();
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('connections')
    .select('provider, key_last4, account_login, created_at')
    .eq('user_id', r.user.id)
    .in('provider', ['anthropic', 'e2b']);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Array<Pick<Connection, 'provider' | 'key_last4' | 'account_login' | 'created_at'>>;
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return NextResponse.json({
    anthropic: shape(byProvider.get('anthropic')),
    e2b: shape(byProvider.get('e2b')),
  });
}

// POST — paste / replace a key. Validates with a tiny live call before
// persisting; tolerates network failure of the validator.
export async function POST(req: Request) {
  const r = await authed();
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = PostBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const { provider, key } = parsed.data;

  // Tiny live validation. Reject only on definitive auth failure; tolerate
  // anything else (the next real call will surface a true error).
  const validator = provider === 'anthropic' ? validateAnthropicKey : validateE2BKey;
  const check = await validator(key);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.message ?? 'key rejected by ' + provider },
      { status: 400 },
    );
  }

  const supabase = getServerSupabase();
  try {
    await upsertConnection(supabase, {
      provider,
      accountLogin: providerLabel(provider),
      token: key,
      scopes: 'api-key',
      userId: r.user.id,
      keyLast4: last4(key),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'persist_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.key_added',
    actor: 'user',
    detail: { provider, key_last4: last4(key), user_id: r.user.id },
  });

  return NextResponse.json({
    status: 'connected',
    provider,
    key_last4: last4(key),
  });
}

// DELETE — remove the key. Audit-only metadata captured; the key was
// already encrypted at rest, so the delete is a one-way drop.
export async function DELETE(req: Request) {
  const r = await authed();
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status });

  const url = new URL(req.url);
  const providerParam = url.searchParams.get('provider');
  const providerResult = ProviderEnum.safeParse(providerParam);
  if (!providerResult.success) {
    return NextResponse.json(
      { error: 'provider must be anthropic or e2b' },
      { status: 400 },
    );
  }
  const provider: ByokProvider = providerResult.data;

  const supabase = getServerSupabase();
  // Capture the last4 (for audit) BEFORE deleting.
  const { data: existing } = await supabase
    .from('connections')
    .select('key_last4')
    .eq('user_id', r.user.id)
    .eq('provider', provider)
    .maybeSingle();
  const wasLast4 = (existing as { key_last4: string | null } | null)?.key_last4 ?? null;

  try {
    await deleteConnection(supabase, r.user.id, provider);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'delete_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.key_removed',
    actor: 'user',
    detail: { provider, key_last4: wasLast4, user_id: r.user.id },
  });

  return NextResponse.json({ status: 'removed', provider });
}

// --- helpers ---------------------------------------------------------------

function shape(
  row: Pick<Connection, 'provider' | 'key_last4' | 'account_login' | 'created_at'> | undefined,
) {
  if (!row) return { connected: false, key_last4: null, connected_at: null };
  return {
    connected: true,
    key_last4: row.key_last4 ?? null,
    connected_at: row.created_at,
  };
}

function providerLabel(provider: ByokProvider): string {
  if (provider === 'anthropic') return 'anthropic';
  return 'e2b';
}
