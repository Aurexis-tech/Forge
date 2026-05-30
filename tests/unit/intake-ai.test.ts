// Hermetic tests for the Intake migration + the (app) backdrop/nav switch.
// node-only: pure-logic (detectMoldHint, isMigratedRoute) + source
// assertions (the create-forge wiring is preserved; the shell is restyled;
// the switch flips backdrop + nav per route).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectMoldHint, scoreMoldSignals } from '@/lib/mold-hint';
import { isMigratedRoute, MIGRATED_ROUTES } from '@/lib/migrated-routes';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. detectMoldHint — pure scoring + ABSTAIN on conflict
// ===========================================================================
describe('detectMoldHint — confident cases', () => {
  it('agents — one ongoing automation (scrape / notify / cadence)', () => {
    // Canonical agent prompt from the brief.
    expect(
      detectMoldHint('Scan new arXiv papers daily and email me a 5-bullet brief'),
    ).toBe('agents');
    // Monitor + notify + cadence — agent-only signals dominate.
    expect(detectMoldHint('monitor my mentions and notify me weekly')).toBe(
      'agents',
    );
  });

  it('systems — multiple things coordinated or aggregated', () => {
    // Coordination + aggregation; "watch" fires agent once but system
    // dominates by 3 vs 1.
    expect(detectMoldHint('coordinate multiple agents to watch competitors')).toBe(
      'systems',
    );
    // One strong system signal with zero competitors elsewhere — second
    // == 0 so the helper commits.
    expect(detectMoldHint('orchestrate a swarm of workers')).toBe('systems');
    // The brief's canonical system prompt — coordinate + digest + a
    // numeric multi-target ("5 competitors"); no agent verbs fire.
    expect(
      detectMoldHint('coordinate three agents into a Monday digest across 5 competitors'),
    ).toBe('systems');
  });

  it('software — people use a UI (app / users / approve)', () => {
    expect(
      detectMoldHint('an app where users submit receipts and managers approve'),
    ).toBe('software');
    expect(
      detectMoldHint('a web app where users sign up and submit expenses'),
    ).toBe('software');
  });

  it('infrastructure — data plane / IaC primitives', () => {
    // Brief's canonical infra prompt.
    expect(detectMoldHint('Postgres with RLS and daily backups')).toBe(
      'infrastructure',
    );
    // Full form — postgres + database + RLS + backups = 4 infra
    // signals; daily fires agent once. Gap wins.
    expect(
      detectMoldHint('a postgres database with row-level security and daily backups'),
    ).toBe('infrastructure');
  });
});

describe('detectMoldHint — ABSTAIN on conflict (the whole point of the rewrite)', () => {
  it('the reported borderline: track / weekly fires agent AND competitors / digest / 5 competitors fires system → null', () => {
    // The exact case that today's keyword-priority helper mis-guesses
    // as "Agent" on track/weekly. The new helper sees agent (track +
    // weekly = 2) AND system (competitors + digest + "5 competitors"
    // + the 3-item comma list = 4) both fire strongly, and refuses to
    // commit. The intake pill will render the neutral "mold set when
    // you forge" state instead of confidently picking the wrong mold.
    expect(
      detectMoldHint(
        'Track our top 5 competitors — pricing pages, hiring, social posts — and surface weekly changes in a Monday digest',
      ),
    ).toBeNull();
  });

  it('property: NEVER returns a confident mold when agent AND system both score ≥ 2', () => {
    // Synthetic that fires ≥2 in each set. Even though the totals
    // could pick a "winner" by gap, the helper abstains because the
    // input genuinely reads as both an automation AND a coordination.
    const text =
      'Track and monitor competitors across teams and report a weekly digest';
    const scores = scoreMoldSignals(text);
    expect(scores.agents).toBeGreaterThanOrEqual(2);
    expect(scores.systems).toBeGreaterThanOrEqual(2);
    expect(detectMoldHint(text)).toBeNull();
  });

  it('returns null for empty / whitespace / off-topic text', () => {
    expect(detectMoldHint('')).toBeNull();
    expect(detectMoldHint('   ')).toBeNull();
    expect(detectMoldHint('hello there friend')).toBeNull();
  });

  it('returns null when the top mold is only barely ahead (no required gap, second != 0)', () => {
    // postgres + app — infra 1 / software 1. No mold reaches ≥2, gap
    // is 0, second != 0 → abstain. (The old keyword-priority helper
    // would have picked infrastructure here; the new helper correctly
    // refuses to commit on so little evidence.)
    expect(detectMoldHint('a postgres database for my app')).toBeNull();
  });
});

describe('scoreMoldSignals — the pure tally exposed for tests', () => {
  it('counts at most +1 per signal pattern, not per occurrence', () => {
    // "weekly weekly weekly" should still only contribute the single
    // /weekly/ pattern's +1 to agents (cap on signal-counting, not
    // word-counting).
    const s = scoreMoldSignals('weekly weekly weekly');
    expect(s.agents).toBe(1);
  });

  it('the 2+ comma rule adds at most +1 to systems (capped, not unbounded)', () => {
    // 5 commas should still only add +1 system signal — long sentences
    // with many commas shouldn't dominate.
    const s = scoreMoldSignals('a, b, c, d, e, f');
    expect(s.systems).toBe(1);
  });

  it('returns all-zeros for empty input (no NaN, no negatives)', () => {
    expect(scoreMoldSignals('')).toEqual({
      agents: 0,
      systems: 0,
      software: 0,
      infrastructure: 0,
    });
  });
});

// ===========================================================================
// 2. The (app) migrated-route allowlist (pure)
// ===========================================================================
describe('isMigratedRoute', () => {
  it('contains /forge (the route this migration moved in)', () => {
    expect([...MIGRATED_ROUTES]).toContain('/forge');
  });
  it('matches migrated routes EXACTLY — children stay un-migrated', () => {
    expect(isMigratedRoute('/forge')).toBe(true);
    // Exact match: /forge/anything is NOT migrated (each child opts in).
    expect(isMigratedRoute('/forge/anything')).toBe(false);
    expect(isMigratedRoute('/settings/connections')).toBe(false);
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
    // Confident state: soft "looks like" prefix — still a guess.
    expect(src).toMatch(/looks like/);
    // Abstain state: intentional neutral copy — NOT an error look. The
    // brief calls for "mold set when you forge" so the user reads it as
    // "the forge decides this for real," not as a failure.
    expect(src).toMatch(/mold set when you forge/);
    // The old "detecting" copy must not survive — that read as a
    // failure / loading state.
    expect(src).not.toMatch(/>\s*detecting\s*</);
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
