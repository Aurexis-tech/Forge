// DB helpers for the `connections` table. Server-only.
//
// SECURITY: this is the ONLY module that decrypts a stored token. Callers
// must pass the decrypted token directly to the provider's SDK (octokit
// etc.) — never log it, never return it in an API response, never store
// it in any other table.

import { decryptSecret, encryptSecret } from '@/lib/crypto';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Connection, ConnectionProvider } from '@/lib/types';

// Real per-user auth landed in the governance commit. All connection helpers
// now require a user_id. Callers obtain it via lib/auth.requireUser(). The
// previous 'forge-default' single-user constant is gone — pre-auth data
// would need a one-time backfill (documented in the root README).

export interface ConnectionPublic {
  id: string;
  user_id: string | null;
  provider: string;
  account_login: string | null;
  scopes: string | null;
  key_last4: string | null;
  created_at: string;
}

// Strip the encrypted token before sending a connection through any code
// path that might bleed it into a response.
function redact(row: Connection): ConnectionPublic {
  return {
    id: row.id,
    user_id: row.user_id,
    provider: row.provider,
    account_login: row.account_login,
    scopes: row.scopes,
    key_last4: row.key_last4 ?? null,
    created_at: row.created_at,
  };
}

export async function loadConnectionPublic(
  supabase: ForgeSupabase,
  provider: ConnectionProvider,
  userId: string,
): Promise<ConnectionPublic | null> {
  const { data, error } = await supabase
    .from('connections')
    .select('id, user_id, provider, account_login, scopes, created_at, token_encrypted')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return redact(data as Connection);
}

// Returns the decrypted token alongside the public row. SERVER-ONLY callers
// (push routes, etc) — never return this from an API response.
export async function loadConnectionWithToken(
  supabase: ForgeSupabase,
  provider: ConnectionProvider,
  userId: string,
): Promise<{ row: ConnectionPublic; token: string } | null> {
  const { data, error } = await supabase
    .from('connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Connection;
  const token = decryptSecret(row.token_encrypted);
  return { row: redact(row), token };
}

export async function upsertConnection(
  supabase: ForgeSupabase,
  args: {
    provider: ConnectionProvider;
    accountLogin: string;
    token: string;
    scopes: string | null;
    userId: string;
    // Last 4 chars for UI display. Only meaningful for BYOK providers
    // (anthropic / e2b). Leave undefined for OAuth providers.
    keyLast4?: string | null;
  },
): Promise<ConnectionPublic> {
  const userId = args.userId;
  const encrypted = encryptSecret(args.token);
  const { data, error } = await supabase
    .from('connections')
    .upsert(
      {
        user_id: userId,
        provider: args.provider,
        account_login: args.accountLogin,
        token_encrypted: encrypted,
        scopes: args.scopes,
        key_last4: args.keyLast4 ?? null,
      },
      { onConflict: 'user_id,provider' },
    )
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('failed to upsert connection');
  return redact(data as Connection);
}

export async function deleteConnection(
  supabase: ForgeSupabase,
  userId: string,
  provider: ConnectionProvider,
): Promise<void> {
  const { error } = await supabase
    .from('connections')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw error;
}
