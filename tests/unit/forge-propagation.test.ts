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

// NOTE: the mold-space + ProjectCard structural assertions have been
// retired alongside the forge MoldSpacePage / ProjectCard / MoldBadge
// (deleted as orphans). The four mold spaces + Home now render via the
// AI-futuristic MoldSpaceAi / MoldGrid / ProjectCardAi — see
// tests/unit/mold-space-ai.test.ts + projects-ai.test.ts. The
// projectCardTone helper this file tests above is still live in
// lib/forge-heat.ts (the forge SpendMeter uses spendHeatTone, and the
// helper is co-located with it).

// ===========================================================================
// 2. Project detail — MIGRATED to AI-futuristic (the workshop shell)
// ===========================================================================
describe('the forge project-detail primitives are preserved (orphaned by the migration)', () => {
  // /projects/[id] has MIGRATED to the AI-futuristic workshop shell — see
  // tests/unit/workshop-ai.test.ts for the new structural assertions. The
  // five forge primitives (SectionHeader / HeatBadge / EmberCard / StagePipeline
  // / Reveal) keep functioning for other un-migrated pages; this check just
  // confirms they were not touched.
  const stagePipeline = read('components/forge/StagePipeline.tsx');

  it('the forge StagePipeline + HeatBadge primitives are still present', () => {
    expect(stagePipeline).toMatch(/forge-stage-dot/);
    const heatBadge = read('components/forge/HeatBadge.tsx');
    expect(heatBadge).toMatch(/HeatBadge/);
  });
});

// ===========================================================================
// 5. Keys — SectionHeader + EmberCard per key + HeatBadge status
// ===========================================================================
describe('the forge KeysForm component is preserved (orphaned by the migration)', () => {
  // /settings/keys has MIGRATED to the AI-futuristic system — see
  // tests/unit/keys-ai.test.ts for the new structural assertions. The
  // forge KeysForm component file is left in place (it'll be deleted at
  // cleanup); these checks confirm it wasn't touched.
  const form = read('components/keys/KeysForm.tsx');

  it('the forge form still uses EmberCard + keyStatusTone (unchanged)', () => {
    expect(form).toMatch(/<EmberCard/);
    expect(form).toMatch(/keyStatusTone/);
    expect(form).not.toMatch(/GlassPanel/);
  });

  it('the forge ConnectedPill is still a HeatBadge', () => {
    expect(form).toMatch(/<HeatBadge/);
    expect(form).toMatch(/keyStatusTone\(true\)\.badge/);
  });
});

// ===========================================================================
// 6. Governance — the forge SpendMeter component is preserved (orphaned)
// ===========================================================================
describe('the forge governance components are preserved (orphaned by the migration)', () => {
  // /governance has MIGRATED to the AI-futuristic system — see
  // tests/unit/governance-ai.test.ts for the new structural assertions. The
  // forge SpendMeter / KillSwitchPanel / BudgetForm component files are left
  // in place (cleanup will delete them later); these checks confirm they
  // weren't touched.
  const meter = read('components/governance/SpendMeter.tsx');

  it('the forge SpendMeter still wires HeatBadge → spendHeatTone (unchanged)', () => {
    expect(meter).toMatch(/<HeatBadge/);
    expect(meter).toMatch(/spendHeatTone\(spendUsd, limitUsd\)/);
    expect(meter).toMatch(/spendHeatLabel\(spendUsd, limitUsd\)/);
  });
});
