// Hermetic tests for the Intake migration + the (app) backdrop/nav switch.
// node-only: pure-logic (detectMoldHint, isMigratedRoute) + source
// assertions (the create-forge wiring is preserved; the shell is restyled;
// the switch flips backdrop + nav per route).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectMoldHint } from '@/lib/mold-hint';
import { isMigratedRoute, MIGRATED_ROUTES } from '@/lib/migrated-routes';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. detectMoldHint — the PURE provisional guess
// ===========================================================================
describe('detectMoldHint', () => {
  it('guesses agents from watch/scan/brief/schedule language', () => {
    expect(
      detectMoldHint('Scan new arXiv papers daily and email me a 5-bullet brief'),
    ).toBe('agents');
    expect(detectMoldHint('monitor my mentions and notify me weekly')).toBe(
      'agents',
    );
  });

  it('guesses systems from coordination language', () => {
    expect(detectMoldHint('coordinate multiple agents to watch competitors')).toBe(
      'systems',
    );
    expect(detectMoldHint('orchestrate a swarm of workers')).toBe('systems');
  });

  it('guesses systems when 3+ broad nouns co-occur', () => {
    expect(
      detectMoldHint('an agent, a system, an app, and a database working together'),
    ).toBe('systems');
  });

  it('guesses software from app/users/approve language', () => {
    expect(
      detectMoldHint('a web app where users sign up and submit expenses'),
    ).toBe('software');
  });

  it('guesses infrastructure from db/rls/backups — and it beats software', () => {
    expect(
      detectMoldHint('a postgres database with row-level security and daily backups'),
    ).toBe('infrastructure');
    // "app" (software) + "postgres/database" (infra); infra has priority.
    expect(detectMoldHint('a postgres database for my app')).toBe(
      'infrastructure',
    );
  });

  it('returns null ("detecting") for empty / ambiguous text', () => {
    expect(detectMoldHint('')).toBeNull();
    expect(detectMoldHint('   ')).toBeNull();
    expect(detectMoldHint('hello there friend')).toBeNull();
  });
});

// ===========================================================================
// 2. The (app) migrated-route allowlist (pure)
// ===========================================================================
describe('isMigratedRoute', () => {
  it('starts with /forge only', () => {
    expect([...MIGRATED_ROUTES]).toEqual(['/forge']);
  });
  it('matches /forge (+ nested) and nothing un-migrated', () => {
    expect(isMigratedRoute('/forge')).toBe(true);
    expect(isMigratedRoute('/forge/anything')).toBe(true);
    expect(isMigratedRoute('/projects')).toBe(false);
    expect(isMigratedRoute('/governance')).toBe(false);
    expect(isMigratedRoute('/')).toBe(false);
    expect(isMigratedRoute(null)).toBe(false);
  });
});

// ===========================================================================
// 3. The backdrop + nav SWITCHES
// ===========================================================================
describe('AppBackdrop switch', () => {
  const src = read('components/lq/AppBackdrop.tsx');
  it('renders AurexisAmbient for migrated routes, Forge backdrop otherwise', () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/usePathname/);
    expect(src).toMatch(/isMigratedRoute/);
    expect(src).toMatch(/<AurexisAmbient\s*\/>/);
    expect(src).toMatch(/<ForgeBackdrop\s*\/>/);
    expect(src).toMatch(/<ForgeScene\s*\/>/);
  });
});

describe('AppShellHeader switch', () => {
  const src = read('components/lq/AppShellHeader.tsx');
  it('renders AiNav for migrated routes, the forge header otherwise', () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/isMigratedRoute/);
    expect(src).toMatch(/<AiNav\s*\/>/);
    expect(src).toMatch(/<AppNav\s*\/>/); // forge nav kept for un-migrated
  });
});

describe('(app) layout mounts the switches', () => {
  const layout = read('app/(app)/layout.tsx');
  it('mounts AppBackdrop + AppShellHeader, no direct backdrop/nav', () => {
    expect(layout).toMatch(/<AppBackdrop\s*\/>/);
    expect(layout).toMatch(/<AppShellHeader\s*\/>/);
    // The direct forge mounts moved into the switches.
    expect(layout).not.toMatch(/<ForgeBackdrop\s*\/>/);
    expect(layout).not.toMatch(/<AppNav\s*\/>/);
  });
});

// ===========================================================================
// 4. The migrated intake — restyled shell, PRESERVED create-forge wiring
// ===========================================================================
describe('IntakeFormAi', () => {
  const src = read('components/intake-ai/IntakeFormAi.tsx');

  it('is a client component on the lq primitives + lq tokens + font-ui', () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/LiquidGlassButton/);
    expect(src).toMatch(/text-lq-ink/);
    expect(src).toMatch(/font-ui/);
    // font-ui set DIRECTLY on the h1 (beats the forge global h1 rule).
    expect(src).toMatch(/<h1 className="font-ui/);
  });

  it('PRESERVES the create-forge wiring exactly (POST raw_prompt → push project)', () => {
    expect(src).toMatch(/fetch\('\/api\/projects'/);
    expect(src).toMatch(/method:\s*'POST'/);
    expect(src).toMatch(/raw_prompt:\s*trimmed/);
    expect(src).toMatch(/router\.push\('\/projects\/' \+ project\.id\)/);
  });

  it('wires ⌘↵ / Ctrl↵ to the same submit', () => {
    expect(src).toMatch(/metaKey \|\| e\.ctrlKey/);
    expect(src).toMatch(/startForge\(\)/);
  });

  it('renders the live mold hint (detectMoldHint) with text + colour, not motion', () => {
    expect(src).toMatch(/detectMoldHint/);
    expect(src).toMatch(/looks like/);
    expect(src).toMatch(/detecting/);
  });

  it('renders the 4 starter chips with the four fill texts', () => {
    expect(src).toMatch(/arXiv computer-vision papers daily/);
    expect(src).toMatch(/top 5 competitors/);
    expect(src).toMatch(/Expense submission and approval app/);
    expect(src).toMatch(/Postgres database for a 4-person team/);
  });

  it('renders the 8-stage idle pipeline (Intent lit, conveyed by label too)', () => {
    expect(src).toMatch(/'Intent'/);
    expect(src).toMatch(/'Live'/);
  });

  it('uses an aurora focus glow (overrides the global amber input rule)', () => {
    expect(src).toMatch(/focus:border-lq-aurora/);
    expect(src).toMatch(/focus:shadow-\[inset_0_0_48px_-16px_rgba\(95,230,255/);
  });
});

describe('/forge route renders the migrated intake', () => {
  it('the page mounts IntakeFormAi (not the forge IntakeForm)', () => {
    const page = read('app/(app)/forge/page.tsx');
    expect(page).toMatch(/IntakeFormAi/);
    expect(page).not.toMatch(/from '@\/components\/IntakeForm'/);
  });
});

// ===========================================================================
// 5. Infinite-loop discipline
// ===========================================================================
describe('infinite-animation budget', () => {
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the intake module has exactly ONE infinite loop (the pulse dot)', () => {
    expect(countInfinite('components/intake-ai/intake.module.css')).toBe(1);
  });

  it('globals.css still ≤4 infinite loops (intake keyframes never leaked there)', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    expect(read('app/globals.css')).not.toMatch(/intakePulse|intakeSurge/);
  });
});
