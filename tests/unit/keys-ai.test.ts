// Hermetic tests for the Keys migration. The honesty constraints (true
// security copy, no fabricated activity, real provider set only) are
// encoded as assertions: the banner copy comes from a single typed
// constant; the page never emits sparklines / "N calls today" / MTD /
// project counts / "tested ago"; phantom providers (Brave / OpenAI /
// GitHub / Vercel / Supabase / Resend) never appear; the destination
// URLs match the real upstream hosts the engine targets; "zero-knowledge"
// stays banned.
//
// The card chrome adds a tinted provider icon + a pulsing-dot status pill
// + a boxed masked-key field with an aurora left border + an optional
// "added <X ago>" line driven by real connected_at. These are pure
// chrome — every value comes from the real API.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatMaskedKey,
  formatRelativeTime,
  KEYS_PROVIDERS,
  KEYS_SECURITY,
  PROVIDER_DESTINATION,
  PROVIDER_ICON,
  keyStatsVm,
  keyStatusVm,
} from '@/lib/keys-config';
import { isMigratedRoute, MIGRATED_ROUTES } from '@/lib/migrated-routes';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. The provider set + destinations are REAL (match the API + upstream hosts)
// ===========================================================================
describe('KEYS_PROVIDERS — exactly the providers the API enforces', () => {
  it("is exactly anthropic + e2b (the route's ProviderEnum)", () => {
    expect(KEYS_PROVIDERS.map((p) => p.provider).sort()).toEqual([
      'anthropic',
      'e2b',
    ]);
    // GitHub / Vercel / Supabase OAuth live on /settings/connections; Brave /
    // OpenAI / Resend are not wired at all — none of these may appear here.
    const providers = KEYS_PROVIDERS.map((p) => p.provider);
    for (const sneaky of [
      'github',
      'vercel',
      'supabase',
      'brave',
      'openai',
      'resend',
    ]) {
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

describe('PROVIDER_ICON — public-fact brand glyph per real provider', () => {
  it('anthropic = amber "A", e2b = violet "E"', () => {
    expect(PROVIDER_ICON.anthropic).toEqual({ letter: 'A', tint: 'amber' });
    expect(PROVIDER_ICON.e2b).toEqual({ letter: 'E', tint: 'violet' });
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

  it('the eyebrow STAYS "encrypted at rest" (never flips to "zero-knowledge")', () => {
    expect(KEYS_SECURITY.eyebrow).toMatch(/encrypted at rest/i);
    expect(KEYS_SECURITY.eyebrow).not.toMatch(/zero[- ]knowledge/i);
  });

  it('does NOT claim browser-session / zero-knowledge / never-server-side / end-to-end', () => {
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
// 3. Pure helpers — masking, status mapping, stats strip, relative time
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

describe('keyStatsVm — header stat strip binds to REAL counts only', () => {
  it('loading → 0 connected / total missing / 0 errors', () => {
    expect(keyStatsVm({ status: null, loading: true })).toEqual({
      connected: 0,
      missing: KEYS_PROVIDERS.length,
      errors: 0,
      loading: true,
    });
  });

  it('both connected → 2 / 0 / 0', () => {
    expect(
      keyStatsVm({
        status: {
          anthropic: { connected: true },
          e2b: { connected: true },
        },
        loading: false,
      }),
    ).toEqual({ connected: 2, missing: 0, errors: 0, loading: false });
  });

  it('one connected → 1 / 1 / 0', () => {
    expect(
      keyStatsVm({
        status: {
          anthropic: { connected: true },
          e2b: { connected: false },
        },
        loading: false,
      }),
    ).toEqual({ connected: 1, missing: 1, errors: 0, loading: false });
  });

  it('errors stays at 0 today — no per-provider error field exists', () => {
    // The "Errors" cell is part of the design strip but the connection
    // record carries no per-provider error state, so today this count is
    // always 0. Documented honestly in the helper.
    const r = keyStatsVm({
      status: { anthropic: { connected: true }, e2b: { connected: false } },
      loading: false,
    });
    expect(r.errors).toBe(0);
  });
});

describe('formatRelativeTime — pure, deterministic with injected nowMs', () => {
  const now = Date.UTC(2026, 5, 30, 12, 0, 0); // fixed clock
  const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString();
  const hoursAgo = (n: number) => new Date(now - n * 3600_000).toISOString();
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

  it('< 1 minute → "just now"', () => {
    expect(formatRelativeTime(minutesAgo(0), now)).toBe('just now');
  });
  it('minutes / hours / days / months / years', () => {
    expect(formatRelativeTime(minutesAgo(5), now)).toBe('5m ago');
    expect(formatRelativeTime(hoursAgo(3), now)).toBe('3h ago');
    expect(formatRelativeTime(daysAgo(2), now)).toBe('2d ago');
    expect(formatRelativeTime(daysAgo(45), now)).toBe('1mo ago');
    expect(formatRelativeTime(daysAgo(400), now)).toBe('1y ago');
  });
  it('null / invalid → "" (caller omits the line)', () => {
    expect(formatRelativeTime(null, now)).toBe('');
    expect(formatRelativeTime(undefined, now)).toBe('');
    expect(formatRelativeTime('not-a-date', now)).toBe('');
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
// 5. The route page is KeysAi (no SectionHeader / forge KeysForm)
// ===========================================================================
describe('/settings/keys page wiring', () => {
  const page = read('app/(app)/settings/keys/page.tsx');

  it('renders the KeysAi client component (not the forge KeysForm)', () => {
    expect(page).toMatch(/<KeysAi\s*\/>/);
    expect(page).not.toMatch(/from '@\/components\/keys\/KeysForm'/);
    expect(page).not.toMatch(/SectionHeader/);
  });

  it('still gates on requireUser (same auth)', () => {
    expect(page).toMatch(/requireUser/);
  });
});

// ===========================================================================
// 6. KeysAi — header chrome + card chrome over REAL fields only
// ===========================================================================
describe('KeysAi component — header + card chrome', () => {
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
    expect(src).toMatch(
      /JSON\.stringify\(\{ provider: info\.provider, key: trimmed \}\)/,
    );
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

  it('the header stat strip binds to keyStatsVm (Connected / Missing / Errors)', () => {
    expect(src).toMatch(/keyStatsVm\(/);
    expect(src).toMatch(/label="Connected"/);
    expect(src).toMatch(/label="Missing"/);
    expect(src).toMatch(/label="Errors"/);
    // The strip values come from the typed VM — never hard-coded numbers.
    expect(src).toMatch(/value=\{stats\.connected\}/);
    expect(src).toMatch(/value=\{stats\.missing\}/);
    expect(src).toMatch(/value=\{stats\.errors\}/);
  });

  it('cards mount a tinted provider icon from the PROVIDER_ICON map', () => {
    expect(src).toMatch(/PROVIDER_ICON\[info\.provider\]/);
    expect(src).toMatch(/ICON_TINT_CLASS/);
  });

  it('connected cards: aurora-left-bordered masked-key box + optional "added X ago"', () => {
    // 2px aurora left border on the connected box.
    expect(src).toMatch(/border-l-2\s+border-l-lq-aurora/);
    // Real masked key + real connected_at via formatRelativeTime.
    expect(src).toMatch(/formatRelativeTime\(/);
    expect(src).toMatch(/status\?\.connected_at/);
  });

  it('empty cards: dashed "paste to connect" treatment (no fake numbers)', () => {
    expect(src).toMatch(/border-dashed/);
    expect(src).toMatch(/paste to connect/);
  });

  it('connected → Test + Rotate primary pair; empty → Connect →', () => {
    // The mockup's primary action pair on connected cards. The labels
    // sit inside a "cancel when open" ternary on each LiquidGlass
    // button, so we match the source's actual ternary shape rather than
    // a >Test< substring.
    expect(src).toMatch(/formMode === 'test' \? 'cancel' : 'Test'/);
    expect(src).toMatch(/formMode === 'rotate' \? 'cancel' : 'Rotate'/);
    // The empty card stays "Connect →".
    expect(src).toMatch(/Connect →/);
  });

  it("Test + Rotate both route through the same real POST endpoint", () => {
    // The component should only have ONE fetch with method 'POST' to
    // /api/connections/keys — the shared verification + persist path the
    // API exposes today. Test and Rotate set a paste-form mode; their
    // submit goes through the same onSubmit, the same POST, the same
    // body shape. No fabricated separate "verify" endpoint anywhere.
    expect(src).not.toMatch(/\/api\/connections\/keys\/(verify|test)/);
    expect(src).not.toMatch(/\/api\/verify-key/);
    // The shared mode state proves it's one form behind two labels.
    expect(src).toMatch(/setFormMode/);
    expect(src).toMatch(/formMode === 'test'/);
    expect(src).toMatch(/formMode === 'rotate'/);
  });

  it('the Test form labels the action honestly (re-verify, not magic)', () => {
    // The form's eyebrow when Test is open tells the user EXACTLY what
    // submitting does — re-paste the key, the server validates against
    // the upstream provider. Not "click to verify silently."
    expect(src).toContain('paste your current key to verify');
  });

  it('DELETE wiring is preserved via a secondary "remove" link (set/verify/rotate/delete intact)', () => {
    // The prompt's "preserve set/verify/rotate/delete wiring" constraint
    // means the DELETE call (onRemove) must remain reachable. We don't
    // put it in the primary pair (the mockup shows Test+Rotate there),
    // but it stays as a quiet rose secondary so users can disconnect.
    expect(src).toMatch(/removing/);
    expect(src).toMatch(/remove key/);
  });

  it('verified pill carries a pulsing aurora-ish dot (.statusPulseDot)', () => {
    expect(src).toMatch(/styles\.statusPulseDot/);
  });

  it('verified cards wear the breathing aurora rim (.verifiedRim)', () => {
    expect(src).toMatch(/styles\.verifiedRim/);
    expect(src).toMatch(/keyStatusVm/);
  });

  it('emits NO fabricated activity (no sparklines, no MTD / N calls / projects / tested ago)', () => {
    expect(src).not.toMatch(/sparkline/i);
    expect(src).not.toMatch(/calls?\s+today/i);
    expect(src).not.toMatch(/tokens?\s+last\s+hour/i);
    expect(src).not.toMatch(/MTD/);
    expect(src).not.toMatch(/projects?\s+using/i);
    expect(src).not.toMatch(/tested\s+\d/i);
    expect(src).not.toMatch(/last\s+tested/i);
  });

  it('does NOT mention any of the phantom providers (Brave / OpenAI / GitHub / Vercel / Supabase / Resend)', () => {
    // The page surfaces ONLY anthropic + e2b. Any phantom name appearing
    // here would be a regression toward the study's fabricated set.
    expect(src).not.toMatch(/\bBrave\b/);
    expect(src).not.toMatch(/\bOpenAI\b/);
    expect(src).not.toMatch(/\bResend\b/);
    // GitHub / Vercel / Supabase have their own OAuth on
    // /settings/connections; they must not be re-introduced here.
    expect(src).not.toMatch(/\bGitHub\b/);
    expect(src).not.toMatch(/\bVercel\b/);
    expect(src).not.toMatch(/\bSupabase\b/);
  });

  it('does NOT include an "Add custom provider" tile (the app supports exactly anthropic + e2b)', () => {
    expect(src).not.toMatch(/add\s+custom\s+provider/i);
    expect(src).not.toMatch(/new\s+provider/i);
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

  it('the keys module has exactly TWO infinite loops (verified rim + status-pulse dot)', () => {
    // Both are documented in the module header:
    //   1. .verifiedRim — slow aurora breathing rim on connected cards
    //   2. .statusPulseDot — small opacity pulse on the Verified pill dot
    expect(countInfinite('components/keys-ai/keys.module.css')).toBe(2);
  });

  it('globals.css still ≤4 infinite loops (keys keyframes never leaked)', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    const css = read('app/globals.css');
    expect(css).not.toMatch(/keysVerifiedRim/);
    expect(css).not.toMatch(/keysStatusPulse/);
  });
});
