// PURE config for the AI-futuristic Keys page. Everything here is checked
// against the REAL system (the /api/connections/keys route + lib/crypto):
//   - The provider set is what the API actually accepts (anthropic, e2b).
//   - The destinations are the real upstream API hosts.
//   - The security copy is literally true of the real storage model
//     (AES-256-GCM at rest in Supabase `connections`, scoped per
//     user × provider, never echoed after save, audit-logged on
//     add/remove). It is NOT a "browser-session, never-server-side" model
//     and is NOT "zero-knowledge" — the server holds APP_ENC_KEY.
//
// Tested directly in node — nothing here renders, nothing fetches.

import type { ByokProvider } from '@/lib/types';

export interface ProviderInfo {
  /** Provider key matching /api/connections/keys' ProviderEnum. */
  readonly provider: ByokProvider;
  /** Brand label shown on the card. */
  readonly label: string;
  /** What this key actually powers, in plain language. */
  readonly powers: string;
  /** Where to mint a new key. */
  readonly hint: string;
}

/** The REAL provider set the BYOK page manages — exactly what the API
 *  enforces. GitHub/Vercel/Supabase OAuth live on /settings/connections;
 *  they are NOT keys and NOT on this page. */
export const KEYS_PROVIDERS: ReadonlyArray<ProviderInfo> = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    powers: 'LLM inference for spec extraction, planning, and codegen.',
    hint: 'Mint a key at console.anthropic.com → API keys.',
  },
  {
    provider: 'e2b',
    label: 'E2B',
    powers: 'Sandboxed code execution during tests and live runtimes.',
    hint: 'Mint a key at e2b.dev → Account → API keys.',
  },
];

/** Real upstream API hosts — shown as a static line under the key. */
export const PROVIDER_DESTINATION: Readonly<Record<ByokProvider, string>> = {
  anthropic: 'api.anthropic.com',
  e2b: 'api.e2b.dev',
};

// ---------------------------------------------------------------------------
// Security copy — single source so claims can't drift from the code.
// Each item below must be LITERALLY TRUE of the system as built; if the
// storage model changes, edit here, not in the JSX.
// ---------------------------------------------------------------------------

export interface KeysSecurityCopy {
  readonly eyebrow: string;
  readonly headline: string;
  readonly mechanism: string;
  readonly claims: ReadonlyArray<string>;
}

export const KEYS_SECURITY: KeysSecurityCopy = {
  // NOT "zero-knowledge" — the server holds APP_ENC_KEY and can decrypt.
  eyebrow: 'BYOK · encrypted at rest',
  headline: 'Your keys, your fuel.',
  mechanism:
    'AES-256-GCM at rest, scoped to your account. Validated with a tiny ' +
    'live call before save; never logged in plaintext; the UI only ever ' +
    'shows the last four characters.',
  claims: [
    'AES-256-GCM at rest',
    'scoped per user × provider',
    'never echoed back — responses carry only last4',
    'audit-logged on add / remove (provider + last4 only)',
  ],
};

// ---------------------------------------------------------------------------
// Tiny pure helpers — masking + status mapping (no real key ever reaches
// the client; we only have last4 from the API).
// ---------------------------------------------------------------------------

/** "•••• •••• •••• abcd" when last4 is present; null otherwise. */
export function formatMaskedKey(last4: string | null): string | null {
  if (!last4) return null;
  return '•••• •••• •••• ' + last4;
}

export type KeyStatus = 'verified' | 'missing' | 'loading';
export type KeyAccent = 'aurora' | 'ink-dim';

export interface KeyStatusVm {
  readonly status: KeyStatus;
  readonly label: string;
  readonly accent: KeyAccent;
}

export function keyStatusVm(input: {
  connected: boolean | null | undefined;
  loading?: boolean;
}): KeyStatusVm {
  if (input.loading) {
    return { status: 'loading', label: 'Loading…', accent: 'ink-dim' };
  }
  if (input.connected) {
    return { status: 'verified', label: 'Verified', accent: 'aurora' };
  }
  return { status: 'missing', label: 'Not connected', accent: 'ink-dim' };
}

// ---------------------------------------------------------------------------
// Provider icon — a tiny tinted letter chip per provider (the design-study
// card-top glyph). The letter is a public fact about the brand; the tint is
// the AI palette accent used for this provider's surface treatments. NOT
// fabricated — the only inputs are the real provider id + brand name.
// ---------------------------------------------------------------------------

export type ProviderIconTint = 'amber' | 'violet';

export interface ProviderIcon {
  /** Single letter shown inside the chip. */
  readonly letter: string;
  /** AI palette accent for the chip's background + border + text. */
  readonly tint: ProviderIconTint;
}

export const PROVIDER_ICON: Readonly<Record<ByokProvider, ProviderIcon>> = {
  anthropic: { letter: 'A', tint: 'amber' },
  e2b: { letter: 'E', tint: 'violet' },
};

// ---------------------------------------------------------------------------
// Header stat-strip view-model — the three real counts shown beside the H1:
//   Connected — providers with a real key on file
//   Missing   — providers without a key yet
//   Errors    — providers in a known-bad state (today: always 0, because no
//               per-provider error field exists on the connection record)
//
// The `errors` count is HONESTLY 0 right now; it stays in the strip because
// the surface is part of the design and will reflect the count the day the
// API begins exposing per-provider error state. Until then it sits at 0.
// ---------------------------------------------------------------------------

export interface KeyStatsVm {
  readonly connected: number;
  readonly missing: number;
  readonly errors: number;
  readonly loading: boolean;
}

export function keyStatsVm(input: {
  /** BYOK status as returned by GET /api/connections/keys. */
  status: Record<string, { connected: boolean }> | null;
  loading?: boolean;
  /** OAuth connection status loaded server-side from `connections` rows.
   *  Each entry is present when the provider has a row on file. The
   *  helper only reads `.connected` — `account_login` / `connected_at`
   *  are part of the snapshot but irrelevant to the stat strip. */
  oauth?: OAuthSnapshotByProvider | null;
}): KeyStatsVm {
  const byokTotal = KEYS_PROVIDERS.length;
  // The OAuth side participates in the totals only when the caller
  // actually hands in an oauth snapshot — otherwise we'd be silently
  // counting providers the caller never said it wanted to display
  // (callers that only manage BYOK still expect the BYOK-only totals).
  const oauthTotal = input.oauth ? OAUTH_PROVIDERS.length : 0;
  const total = byokTotal + oauthTotal;
  // OAuth status comes from the server snapshot — it doesn't participate
  // in the client BYOK loading state.
  const oauthConnected = input.oauth
    ? OAUTH_PROVIDERS.filter((p) => input.oauth?.[p.provider]?.connected).length
    : 0;
  if (input.loading || !input.status) {
    // BYOK side hasn't loaded yet; report only what we know honestly.
    return {
      connected: oauthConnected,
      missing: total - oauthConnected,
      errors: 0,
      loading: !!input.loading,
    };
  }
  const byokConnected = KEYS_PROVIDERS.filter(
    (p) => input.status?.[p.provider]?.connected,
  ).length;
  const connected = byokConnected + oauthConnected;
  return { connected, missing: total - connected, errors: 0, loading: false };
}

// ---------------------------------------------------------------------------
// OAuth connections — the 3 platform integrations that live alongside the
// BYOK keys in the unified `connections` table. The Keys page READS their
// status server-side via loadConnectionPublic; the Connect / Manage
// affordance LINKS OUT to /settings/connections (which is where the real
// OAuth handshake + disconnect logic lives). We never run OAuth here.
// ---------------------------------------------------------------------------

export type OAuthProvider = 'github' | 'vercel' | 'supabase';
export type OAuthIconTint = 'ink' | 'mint';

export interface OAuthProviderInfo {
  readonly provider: OAuthProvider;
  readonly label: string;
  /** One-letter glyph for the tinted icon tile. */
  readonly letter: string;
  /** Icon tile tint (brief: github = ink, vercel = ink, supabase = mint). */
  readonly tint: OAuthIconTint;
  /** Brief "what this unlocks" copy — only shown when not connected,
   *  because the empty state has nothing else honest to say. */
  readonly unlocks: string;
}

export const OAUTH_PROVIDERS: ReadonlyArray<OAuthProviderInfo> = [
  {
    provider: 'github',
    label: 'GitHub',
    letter: 'G',
    tint: 'ink',
    unlocks: 'private repos for builds',
  },
  {
    provider: 'vercel',
    label: 'Vercel',
    letter: 'V',
    tint: 'ink',
    unlocks: 'deploys',
  },
  {
    provider: 'supabase',
    label: 'Supabase',
    letter: 'S',
    tint: 'mint',
    unlocks: 'managed Postgres',
  },
];

/** Where every Connect / Manage button on an OAuth card sends the user.
 *  The real flow lives there — we don't run OAuth on the Keys page. */
export const OAUTH_FLOW_HREF = '/settings/connections';

/** Public-safe OAuth snapshot the server loads with loadConnectionPublic
 *  and hands to KeysAi as initial props. Only the fields the UI actually
 *  uses are kept — everything else (encrypted token, ids) stays server-
 *  side. `key_last4` is intentionally absent (OAuth tokens are not masked
 *  keys; conflating the two would be dishonest). */
export interface OAuthConnectionSnapshot {
  readonly connected: boolean;
  readonly account_login: string | null;
  readonly connected_at: string | null;
}

export type OAuthSnapshotByProvider = Readonly<
  Partial<Record<OAuthProvider, OAuthConnectionSnapshot>>
>;

// ---------------------------------------------------------------------------
// Relative timestamp — for the "added <X ago>" line on connected cards.
// Pure + deterministic (pass a `nowMs` for tests). Falls back to an empty
// string for null / invalid input so the caller can omit the line.
// ---------------------------------------------------------------------------

export function formatRelativeTime(
  iso: string | null | undefined,
  nowMs?: number,
): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const now = nowMs ?? Date.now();
  const deltaMs = Math.max(0, now - t);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  const years = Math.floor(months / 12);
  return years + 'y ago';
}
