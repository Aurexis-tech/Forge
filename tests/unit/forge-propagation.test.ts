// Hermetic tests for propagating the forge design language to every app
// page. Two tiers, matching the house style:
//
//   1. PURE HELPERS (lib/forge-heat) — the heat-as-meaning decisions:
//      spend warms cool→ember→glow→molten toward the cap; cards tint
//      warm/cool/none by recency+liveness; key status earns heat only
//      when verified. These are the only LOGIC in the propagation; the
//      pages are thin JSX over the 5 primitives + these helpers.
//
//   2. STRUCTURAL — each remaining page composes the expected primitives
//      (no flat-black holes), the project-detail StagePipeline reflects
//      the ACTUAL journey stage, and the governance spend badge is wired
//      to the warming helper.
//
// No DOM env (vitest + node), so the structural tier reads source and
// asserts the wiring, exactly like forge-design-language.test.ts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  keyStatusTone,
  projectCardTone,
  spendHeatLabel,
  spendHeatTone,
} from '@/lib/forge-heat';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. Pure heat helpers
// ===========================================================================
describe('spendHeatTone — the budget you can SEE heating up', () => {
  it('is cool with no cap (nothing to heat toward)', () => {
    expect(spendHeatTone(123, null)).toBe('cool');
    expect(spendHeatTone(123, 0)).toBe('cool');
  });

  it('warms cool → ember → glow → molten as spend approaches + crosses the cap', () => {
    const cap = 100;
    expect(spendHeatTone(10, cap)).toBe('cool'); //   10% — headroom
    expect(spendHeatTone(49, cap)).toBe('cool'); //   49% — still cool
    expect(spendHeatTone(50, cap)).toBe('ember'); //  50% — warming
    expect(spendHeatTone(79, cap)).toBe('ember'); //  79%
    expect(spendHeatTone(80, cap)).toBe('glow'); //   80% — danger zone
    expect(spendHeatTone(99, cap)).toBe('glow'); //   99%
    expect(spendHeatTone(100, cap)).toBe('molten'); // at cap — hottest
    expect(spendHeatTone(140, cap)).toBe('molten'); // over cap
  });

  it('is monotonic — the tone never cools as spend rises', () => {
    const rank = { cool: 0, ember: 1, glow: 2, molten: 3 } as Record<
      string,
      number
    >;
    let prev = -1;
    for (let pct = 0; pct <= 150; pct += 5) {
      const r = rank[spendHeatTone(pct, 100)]!;
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('spendHeatLabel reads the situation in plain words', () => {
    expect(spendHeatLabel(50, null)).toBe('no cap');
    expect(spendHeatLabel(100, 100)).toBe('cap reached');
    expect(spendHeatLabel(150, 100)).toBe('cap reached');
    expect(spendHeatLabel(40, 100)).toBe('40% of cap');
  });
});

describe('projectCardTone — warm → cool by recency, with discipline', () => {
  const now = Date.UTC(2026, 0, 2, 0, 0, 0); // fixed clock
  const hoursAgo = (h: number) => now - h * 60 * 60 * 1000;

  it('a live/settled forge cools to cyan regardless of age', () => {
    expect(
      projectCardTone({ isLive: true, createdAtMs: hoursAgo(1), nowMs: now }),
    ).toBe('cool');
    expect(
      projectCardTone({ isLive: true, createdAtMs: hoursAgo(500), nowMs: now }),
    ).toBe('cool');
  });

  it('a recently-started forge still glows warm (hot off the anvil)', () => {
    expect(
      projectCardTone({ isLive: false, createdAtMs: hoursAgo(2), nowMs: now }),
    ).toBe('warm');
    expect(
      projectCardTone({ isLive: false, createdAtMs: hoursAgo(35), nowMs: now }),
    ).toBe('warm');
  });

  it('the older / dormant long tail sits quiet (no amber-everywhere)', () => {
    expect(
      projectCardTone({ isLive: false, createdAtMs: hoursAgo(48), nowMs: now }),
    ).toBe('none');
  });
});

describe('keyStatusTone — heat is earned by a verified, in-use key', () => {
  it('verified → warm card + working-heat (glow) badge', () => {
    expect(keyStatusTone(true)).toEqual({ card: 'warm', badge: 'glow' });
  });
  it('missing → quiet (no heat earned)', () => {
    expect(keyStatusTone(false)).toEqual({ card: 'none', badge: 'dim' });
  });
});

// ===========================================================================
// 2. Home + the four mold spaces compose the foundation
// ===========================================================================
describe('un-migrated mold spaces still wear the forge surface', () => {
  // Home (/projects) has MIGRATED to the AI-futuristic system — see
  // tests/unit/projects-ai.test.ts for the new structural assertions. The
  // four mold spaces are still forge-styled, so the propagation assertions
  // still apply to them.
  const moldSpace = read('components/MoldSpacePage.tsx');

  it('a mold space composes SectionHeader + ProjectCard + EmberCard + Reveal', () => {
    expect(moldSpace).toMatch(/SectionHeader/);
    expect(moldSpace).toMatch(/<ProjectCard/);
    expect(moldSpace).toMatch(/<EmberCard/);
    expect(moldSpace).toMatch(/Reveal/);
    expect(moldSpace).toMatch(/meta\.emptyLine/); // per-mold empty state
    expect(moldSpace).not.toMatch(/GlassPanel/);
  });
});

// ===========================================================================
// 3. ProjectCard — EmberCard (recency tone) + HeatBadge stage + MoldBadge
// ===========================================================================
describe('ProjectCard is a forge surface', () => {
  const card = read('components/ProjectCard.tsx');

  it('is an EmberCard whose tone is the recency/liveness heat (projectCardTone)', () => {
    expect(card).toMatch(/<EmberCard/);
    expect(card).toMatch(/projectCardTone/);
    expect(card).toMatch(/tone=\{tone\}/);
  });

  it('the stage pill is a HeatBadge (cool when live, dim otherwise) + keeps the mold badge', () => {
    expect(card).toMatch(/<HeatBadge/);
    expect(card).toMatch(/journey\.isLive \? 'cool' : 'dim'/);
    expect(card).toMatch(/<MoldBadge/);
  });

  it('lifts to a heat-glow border on hover', () => {
    expect(card).toMatch(/group-hover:border-heat-glow/);
  });
});

// ===========================================================================
// 4. Project detail — SectionHeader + the cooling spine + EmberCards
// ===========================================================================
describe('project detail adopts the forge language', () => {
  const detail = read('app/(app)/projects/[id]/page.tsx');

  it('the header is a SectionHeader with a HeatBadge status (cool when live)', () => {
    expect(detail).toMatch(/<SectionHeader/);
    expect(detail).toMatch(/<HeatBadge tone=\{journey\.isLive \? 'cool' : 'dim'\}/);
  });

  it('renders a StagePipeline mapped from the ACTUAL journey (stages + cursor)', () => {
    expect(detail).toMatch(/<StagePipeline/);
    // The stages come from the live journey, and the active index is the
    // cursor — so the cooling colors reflect the real current stage.
    expect(detail).toMatch(/journey\.stages\.map\(\(s\) => \(\{ id: s\.id, label: s\.label \}\)\)/);
    expect(detail).toMatch(/journey\.cursor\.id/);
  });

  it('the cooling spine + raw-intent sit on EmberCards, and the redundant 2D overlay is gone', () => {
    expect(detail).toMatch(/<EmberCard tone=\{journey\.isLive \? 'cool' : 'warm'\}>/);
    expect(detail).toMatch(/<EmberCard tone="none">/);
    expect(detail).not.toMatch(/JourneyOverlay/); // StagePipeline replaces it
  });
});

// ===========================================================================
// 5. Keys — SectionHeader + EmberCard per key + HeatBadge status
// ===========================================================================
describe('keys page is restrained forge', () => {
  const page = read('app/(app)/settings/keys/page.tsx');
  const form = read('components/keys/KeysForm.tsx');

  it('the page header is a SectionHeader', () => {
    expect(page).toMatch(/<SectionHeader/);
  });

  it('each key card is an EmberCard whose tone follows verification (keyStatusTone)', () => {
    expect(form).toMatch(/<EmberCard/);
    expect(form).toMatch(/keyStatusTone/);
    expect(form).not.toMatch(/GlassPanel/);
  });

  it('the connected pill is a HeatBadge (warm when verified)', () => {
    expect(form).toMatch(/<HeatBadge/);
    expect(form).toMatch(/keyStatusTone\(true\)\.badge/);
  });
});

// ===========================================================================
// 6. Governance — SectionHeader + EmberCards + spend that heats up
// ===========================================================================
describe('governance shows the budget heating up', () => {
  const page = read('app/(app)/governance/page.tsx');
  const meter = read('components/governance/SpendMeter.tsx');

  it('the page header is a SectionHeader and surfaces sit on EmberCards', () => {
    expect(page).toMatch(/<SectionHeader/);
    expect(page).toMatch(/<EmberCard/);
    expect(page).not.toMatch(/GlassPanel/);
  });

  it('runtime status is a HeatBadge (active glows; errored stays alarming)', () => {
    expect(page).toMatch(/<HeatBadge/);
    expect(page).toMatch(/rt\.status === 'active'/);
    expect(page).toMatch(/border-rose-400\/50 text-rose-300/); // errored stays red
  });

  it('the SpendMeter wires a HeatBadge to the warming helper (cool→…→molten)', () => {
    expect(meter).toMatch(/<HeatBadge/);
    expect(meter).toMatch(/spendHeatTone\(spendUsd, limitUsd\)/);
    expect(meter).toMatch(/spendHeatLabel\(spendUsd, limitUsd\)/);
  });
});
