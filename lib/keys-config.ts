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
