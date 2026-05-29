// Hermetic tests for the Keys migration. The honesty constraints (true
// security copy, no fabricated activity) are encoded as assertions: the
// banner copy comes from a single typed constant, the page never emits
// sparklines/call-counts, and the destination URLs match the real upstream
// hosts the engine targets.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatMaskedKey,
  KEYS_PROVIDERS,
  KEYS_SECURITY,
  PROVIDER_DESTINATION,
  keyStatusVm,
} from '@/lib/keys-config';
import { isMigratedRoute, MIGRATED_ROUTES } from '@/lib/migrated-routes';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. The provider set + destinations are REAL (match the API + upstream hosts)
// ===========================================================================
describe('KEYS_PROVIDERS — exactly the providers the API enforces', () => {
  it('is exactly anthropic + e2b (the route\'s ProviderEnum)', () => {
    expect(KEYS_PROVIDERS.map((p) => p.provider).sort()).toEqual([
      'anthropic',
      'e2b',
    ]);
    // GitHub / Vercel / Supabase OAuth live on /settings/connections — they
    // are NOT BYOK keys and must not appear on this page.
    const providers = KEYS_PROVIDERS.map((p) => p.provider);
    for (const sneaky of ['github', 'vercel', 'supabase', 'brave', 'openai']) {
      expect(providers).not.toContain(sneaky);
    }
  });

  it('each provider has a label, a "powers" sentence, and a key-mint hint', () => {
    for (const p of KEYS_PROVIDERS) {
      expect(p.label.length, p.provider).toBeGreaterThan(0);
      expect(p.powers.length, p.provider).toBeGreaterThan(10);
      expect(p.hint, p.provider).toMatch(/key/);
    }
  });
});

describe('PROVIDER_DESTINATION — real upstream API hosts', () => {
  it('maps each provider to its real host', () => {
    expect(PROVIDER_DESTINATION.anthropic).toBe('api.anthropic.com');
    expect(PROVIDER_DESTINATION.e2b).toBe('api.e2b.dev');
  });
});

// ===========================================================================
// 2. The security banner is TRUE — single source, no false claims
// ===========================================================================
describe('KEYS_SECURITY — the banner copy is literally true', () => {
  it('describes the REAL storage mechanism (AES-256-GCM at rest)', () => {
    expect(KEYS_SECURITY.mechanism).toMatch(/AES-256-GCM/);
    expect(KEYS_SECURITY.mechanism).toMatch(/last four characters/);
  });

  it('does NOT claim browser-session or zero-knowledge (the server can decrypt)', () => {
    const joined =
      KEYS_SECURITY.eyebrow +
      ' ' +
      KEYS_SECURITY.headline +
      ' ' +
      KEYS_SECURITY.mechanism +
      ' ' +
      KEYS_SECURITY.claims.join(' ');
    expect(joined).not.toMatch(/zero[- ]knowledge/i);
    expect(joined).not.toMatch(/browser[- ]session/i);
    expect(joined).not.toMatch(/never\s+server[- ]side/i);
    expect(joined).not.toMatch(/end[- ]to[- ]end/i);
  });

  it('the four trailing claims each name a real property of the system', () => {
    expect(KEYS_SECURITY.claims).toHaveLength(4);
    const joined = KEYS_SECURITY.claims.join(' ');
    expect(joined).toMatch(/AES-256-GCM/);
    expect(joined).toMatch(/per user.*provider/);
    expect(joined).toMatch(/last4|last 4/);
    expect(joined).toMatch(/audit/);
  });
});

// ===========================================================================
// 3. Pure helpers — masking + status mapping
// ===========================================================================
describe('formatMaskedKey + keyStatusVm', () => {
  it('formatMaskedKey returns dots + last4 (or null when last4 is absent)', () => {
    expect(formatMaskedKey('abcd')).toBe('•••• •••• •••• abcd');
    expect(formatMaskedKey(null)).toBeNull();
  });

  it("keyStatusVm: connected → 'Verified' aurora; missing → 'Not connected'", () => {
    expect(keyStatusVm({ connected: true })).toEqual({
      status: 'verified',
      label: 'Verified',
      accent: 'aurora',
    });
    expect(keyStatusVm({ connected: false })).toEqual({
      status: 'missing',
      label: 'Not connected',
      accent: 'ink-dim',
    });
    expect(keyStatusVm({ connected: false, loading: true })).toEqual({
      status: 'loading',
      label: 'Loading…',
      accent: 'ink-dim',
    });
  });
});

// ===========================================================================
// 4. /settings/keys is migrated; backdrop switch covers it
// ===========================================================================
describe('/settings/keys is in MIGRATED_ROUTES (exact match)', () => {
  it('contains /settings/keys', () => {
    expect(MIGRATED_ROUTES).toContain('/settings/keys');
    expect(isMigratedRoute('/settings/keys')).toBe(true);
    // Exact match — a hypothetical child stays un-migrated.
    expect(isMigratedRoute('/settings/keys/extra')).toBe(false);
    // The other settings root is un-migrated.
    expect(isMigratedRoute('/settings/connections')).toBe(false);
  });
});

// ===========================================================================
// 5. The route page is now KeysAi (no SectionHeader / forge KeysForm)
// ===========================================================================
describe('/settings/keys page wiring', () => {
  const page = read('app/(app)/settings/keys/page.tsx');

  it('renders the new KeysAi client component (not the forge KeysForm)', () => {
    expect(page).toMatch(/<KeysAi\s*\/>/);
    expect(page).not.toMatch(/from '@\/components\/keys\/KeysForm'/);
    expect(page).not.toMatch(/SectionHeader/);
  });

  it('still gates on requireUser (same auth)', () => {
    expect(page).toMatch(/requireUser/);
  });
});

// ===========================================================================
// 6. KeysAi — preserves the wiring + uses real fields only
// ===========================================================================
describe('KeysAi component', () => {
  const src = read('components/keys-ai/KeysAi.tsx');

  it('is a client component on the lq primitives + lq tokens + font-ui', () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/font-ui/);
    expect(src).toMatch(/<h1 className="font-ui/);
  });

  it('PRESERVES the key-management wiring exactly (GET / POST / DELETE)', () => {
    expect(src).toMatch(/fetch\('\/api\/connections\/keys'/);
    expect(src).toMatch(/method:\s*'GET'/);
    expect(src).toMatch(/method:\s*'POST'/);
    expect(src).toMatch(/JSON\.stringify\(\{ provider: info\.provider, key: trimmed \}\)/);
    expect(src).toMatch(
      /fetch\(\s*'\/api\/connections\/keys\?provider=' \+ info\.provider/,
    );
    expect(src).toMatch(/method:\s*'DELETE'/);
  });

  it('drives the banner copy from the single KEYS_SECURITY constant', () => {
    expect(src).toMatch(/KEYS_SECURITY\.eyebrow/);
    expect(src).toMatch(/KEYS_SECURITY\.headline/);
    expect(src).toMatch(/KEYS_SECURITY\.mechanism/);
    expect(src).toMatch(/KEYS_SECURITY\.claims/);
  });

  it('emits NO fabricated activity (no sparklines, no call counts)', () => {
    expect(src).not.toMatch(/sparkline/i);
    expect(src).not.toMatch(/calls?\s+today/i);
    expect(src).not.toMatch(/tokens?\s+last\s+hour/i);
  });

  it('verified cards wear the breathing aurora rim (1 documented loop)', () => {
    expect(src).toMatch(/styles\.verifiedRim/);
    expect(src).toMatch(/keyStatusVm/);
  });
});

// ===========================================================================
// 7. Infinite-animation budget — module loop count + globals.css enforcer
// ===========================================================================
describe('infinite-animation budget', () => {
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the keys module has exactly ONE infinite loop (the verified rim)', () => {
    expect(countInfinite('components/keys-ai/keys.module.css')).toBe(1);
  });

  it('globals.css still ≤4 infinite loops (keys keyframes never leaked)', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    expect(read('app/globals.css')).not.toMatch(/keysVerifiedRim/);
  });
});
