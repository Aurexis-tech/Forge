// BYOK key resolution — the fuel question, asked once per call.
//
//   resolveKey(userId, provider) →
//     1. user has a BYOK key for provider → { key, source: 'byok' }
//     2. REQUIRE_BYOK is true (DEFAULT) and no BYOK key → NeedsKeyError
//     3. fall back to the platform env key → { key, source: 'platform' }
//
// This is the ONLY module that decides who's paying. Every LLM / sandbox
// call goes through here so the answer is consistent.

import { decryptSecret } from '@/lib/crypto';
import { getServerSupabase, type ForgeSupabase } from '@/lib/supabase';
import type { ByokProvider, Connection, KeySource } from '@/lib/types';

export class NeedsKeyError extends Error {
  readonly provider: ByokProvider;
  readonly require_byok: boolean;
  constructor(provider: ByokProvider) {
    super('needs_key:' + provider);
    this.name = 'NeedsKeyError';
    this.provider = provider;
    this.require_byok = isRequireByok();
  }
}

export interface ResolvedKey {
  key: string;
  source: KeySource;
  // Last 4 chars of the key in use, handy for audit-friendly logging.
  // The full key never leaves this module's return value.
  key_last4: string;
}

export interface PeekedKey {
  source: KeySource | 'missing';
  key_last4: string | null;
}

const PLATFORM_ENV: Record<ByokProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  e2b: 'E2B_API_KEY',
};

export function isRequireByok(): boolean {
  const raw = (process.env.REQUIRE_BYOK ?? 'true').trim().toLowerCase();
  // DEFAULT TRUE — the founder-protecting flag. Explicit 'false' / '0' /
  // 'off' / 'no' opt out.
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

export async function resolveKey(
  userId: string | null,
  provider: ByokProvider,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<ResolvedKey> {
  // 1. Try the user's BYOK connection first.
  if (userId) {
    const conn = await loadKeyConnection(supabase, userId, provider);
    if (conn) {
      const key = decryptSecret(conn.token_encrypted);
      return { key, source: 'byok', key_last4: conn.key_last4 ?? last4(key) };
    }
  }

  // 2. Founder-protection: if BYOK is required, refuse to fall back.
  if (isRequireByok()) {
    throw new NeedsKeyError(provider);
  }

  // 3. Fall back to the platform key.
  const envName = PLATFORM_ENV[provider];
  const key = (process.env[envName] ?? '').trim();
  if (!key) {
    // No platform key AND no user key — same UX as needing a key.
    throw new NeedsKeyError(provider);
  }
  return { key, source: 'platform', key_last4: last4(key) };
}

// Cheap version of resolveKey that doesn't throw. Used by route-guard to
// pick the right keySource for budget-cap purposes without burning an LLM
// call. Returns 'missing' rather than throwing when no key is available.
export async function peekKeySource(
  userId: string | null,
  provider: ByokProvider,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<PeekedKey> {
  if (userId) {
    try {
      const conn = await loadKeyConnection(supabase, userId, provider);
      if (conn) {
        return { source: 'byok', key_last4: conn.key_last4 };
      }
    } catch {
      // RLS / network blip — treat as missing so the guard fails closed.
      return { source: 'missing', key_last4: null };
    }
  }
  if (isRequireByok()) return { source: 'missing', key_last4: null };
  const envName = PLATFORM_ENV[provider];
  if (process.env[envName]) return { source: 'platform', key_last4: null };
  return { source: 'missing', key_last4: null };
}

// "BYOK for ANY of these providers" — used by route-guard to decide whether
// to skip the budget cap at the route level. A user who's brought ONE key
// is generally a self-funder; we don't quibble about which provider the
// route happens to hit.
export async function userHasAnyByok(
  userId: string | null,
  providers: ByokProvider[],
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await supabase
    .from('connections')
    .select('provider')
    .eq('user_id', userId)
    .in('provider', providers);
  if (error) return false;
  return (data ?? []).length > 0;
}

async function loadKeyConnection(
  supabase: ForgeSupabase,
  userId: string,
  provider: ByokProvider,
): Promise<Connection | null> {
  const { data, error } = await supabase
    .from('connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw error;
  return (data as Connection | null) ?? null;
}

export function last4(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

// --- light-touch validators (server-side, cheap) ---------------------------
// These run when a user pastes a key, BEFORE we persist it. They never log
// or echo the key; they only verify the provider accepts it. If the network
// is flaky we tolerate the call failing — caller decides whether to skip.

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

export async function validateAnthropicKey(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      // The smallest possible request: 1 input token, 1 output token.
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'key rejected by Anthropic' };
    }
    // Any non-auth response (200, 400 for unknown model, 429, etc) confirms
    // the key parses + authenticates. We don't insist the call succeed.
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'validation network error';
    return { ok: false, message: msg };
  }
}

export async function validateE2BKey(key: string): Promise<ValidationResult> {
  // E2B's REST surface for key validation isn't fully public; the cheapest
  // sanity check is a HEAD/GET to api.e2b.dev/health with the key set.
  // Tolerate network failure — the next sandbox call will catch a bad key.
  try {
    const res = await fetch('https://api.e2b.dev/health', {
      headers: { 'x-api-key': key },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'key rejected by E2B' };
    }
    return { ok: true };
  } catch {
    // Network unreachable from the Forge — let the user proceed and find
    // out on the next sandbox run.
    return { ok: true };
  }
}
