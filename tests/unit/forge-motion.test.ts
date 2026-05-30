// Hermetic tests for the signature MOTION layer. Two tiers, house style:
//
//   1. BEHAVIOUR — the pure motion logic: tokens resolve from one module;
//      the reduced-motion shortcut collapses to 0 (verified by toggling a
//      stubbed matchMedia, not by asserting the query exists); the stage
//      temperature advances with the cursor (tempFor).
//
//   2. STRUCTURAL — the wiring: CSS vars mirror the module; components
//      reference the tokens (no scattered magic-number durations); the
//      forge moment fires in PARALLEL with submit (never awaited); each
//      primitive's motion is governed by a reduced-motion-frozen class.
//
// No DOM env, so tier 2 reads source — exactly like the other forge tests.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EASE,
  MOTION,
  motionMs,
  motionVar,
  prefersReducedMotion,
} from '@/lib/forge-motion';
import { tempFor } from '@/components/forge/StagePipeline';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1a. Tokens resolve from ONE module
// ===========================================================================
describe('motion tokens', () => {
  it('every named duration is a positive number of ms', () => {
    for (const [name, ms] of Object.entries(MOTION)) {
      expect(typeof ms, name).toBe('number');
      expect(ms, name).toBeGreaterThan(0);
    }
    // The four the brief calls out by name exist.
    expect(MOTION.forgeMoment).toBeGreaterThanOrEqual(1200);
    expect(MOTION.forgeMoment).toBeLessThanOrEqual(1600);
    expect(MOTION).toHaveProperty('stageCool');
    expect(MOTION).toHaveProperty('hoverWarm');
    expect(MOTION).toHaveProperty('revealStep');
  });

  it('easings are cubic-bezier strings', () => {
    for (const [name, ease] of Object.entries(EASE)) {
      expect(ease, name).toMatch(/^cubic-bezier\(/);
    }
  });

  it('motionVar maps a token to its mirrored CSS custom property', () => {
    expect(motionVar('forgeMoment')).toBe('var(--motion-forge-moment)');
    expect(motionVar('stageCool')).toBe('var(--motion-stage-cool)');
    expect(motionVar('revealStep')).toBe('var(--motion-reveal-step)');
  });
});

// ===========================================================================
// 1b. The reduced-motion shortcut — VERIFIED behaviour, both branches
// ===========================================================================
describe('reduced-motion shortcut (motionMs / prefersReducedMotion)', () => {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    if (orig) Object.defineProperty(globalThis, 'window', orig);
    else delete (globalThis as { window?: unknown }).window;
  });

  function stubReducedMotion(matches: boolean) {
    (globalThis as { window?: unknown }).window = {
      matchMedia: (q: string) => ({ matches, media: q }),
    };
  }

  it('motionMs returns the full duration when motion is allowed', () => {
    expect(motionMs('forgeMoment', false)).toBe(MOTION.forgeMoment);
    expect(motionMs('stageCool', false)).toBe(MOTION.stageCool);
    expect(motionMs(1234, false)).toBe(1234);
  });

  it('motionMs collapses to an INSTANT 0 under reduced motion', () => {
    // The forge moment is instant; the stage swap is instant; the same end
    // state still happens, just not animated.
    expect(motionMs('forgeMoment', true)).toBe(0);
    expect(motionMs('stageCool', true)).toBe(0);
    expect(motionMs(1234, true)).toBe(0);
  });

  it('prefersReducedMotion reads the media query when a window exists', () => {
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(motionMs('forgeMoment')).toBe(0); // default arg consults it

    stubReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(motionMs('forgeMoment')).toBe(MOTION.forgeMoment);
  });

  it('prefersReducedMotion is false (safe) with no window (SSR / test)', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(prefersReducedMotion()).toBe(false);
  });
});

// ===========================================================================
// 1c. Stage transition is DRIVEN by cursor advancement (tempFor)
// ===========================================================================
describe('StagePipeline tempFor — cursor advancement drives the heat', () => {
  it('classifies before/at/after the cursor as cooled/molten/pending', () => {
    expect(tempFor(0, 2, false)).toBe('cooled');
    expect(tempFor(1, 2, false)).toBe('cooled');
    expect(tempFor(2, 2, false)).toBe('molten'); // the active stage
    expect(tempFor(3, 2, false)).toBe('pending');
  });

  it('advancing the cursor warms the new stage and cools the old one', () => {
    // Cursor at 2: stage 2 molten, stage 3 pending.
    expect(tempFor(2, 2, false)).toBe('molten');
    expect(tempFor(3, 2, false)).toBe('pending');
    // Cursor advances to 3: stage 2 has COOLED, stage 3 has WARMED.
    expect(tempFor(2, 3, false)).toBe('cooled');
    expect(tempFor(3, 3, false)).toBe('molten');
  });

  it('the final stage settles cool (LIVE), never molten', () => {
    expect(tempFor(7, 7, true)).toBe('cooled');
  });
});

// ===========================================================================
// 2a. CSS vars mirror the module (one source, two surfaces in sync)
// ===========================================================================
describe('globals.css mirrors the motion tokens', () => {
  const css = read('app/globals.css');
  it('every duration token has a matching --motion-* custom property', () => {
    expect(css).toContain(`--motion-forge-moment: ${MOTION.forgeMoment}ms`);
    expect(css).toContain(`--motion-stage-cool: ${MOTION.stageCool}ms`);
    expect(css).toContain(`--motion-hover-warm: ${MOTION.hoverWarm}ms`);
    expect(css).toContain(`--motion-reveal-step: ${MOTION.revealStep}ms`);
    expect(css).toContain(`--motion-heat-bar: ${MOTION.heatBar}ms`);
  });

  it('the bounded keyframes + the reduced-motion kill-switch both exist', () => {
    expect(css).toMatch(/@keyframes forge-moment\b/);
    expect(css).toMatch(/@keyframes forge-stage-warm\b/);
    expect(css).toMatch(/@keyframes forge-heat-bar\b/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(css).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });

  it('the forge-moment + heat-bar keyframes reference the mirrored vars', () => {
    expect(css).toMatch(/animation: forge-moment var\(--motion-forge-moment\)/);
    expect(css).toMatch(/animation: forge-heat-bar var\(--motion-heat-bar\)/);
  });

  it('only the ambient field + loading bar loop forever (bounded discipline)', () => {
    // Count `infinite` keyframe usages — the embers, the two breathes, and
    // the loading heat-bar. Nothing else should loop.
    const infinites = css.match(/animation[^;]*infinite/g) ?? [];
    // forge-css-ember, forge-breathe, forge-ambient-breathe, forge-heat-bar
    expect(infinites.length).toBeLessThanOrEqual(4);
    // The signature motions are single-play (forwards / both), not infinite.
    expect(css).toMatch(/forge-moment[^;]*forwards/);
    expect(css).toMatch(/forge-stage-warm[^;]*both/);
  });
});

// ===========================================================================
// 2b. Components reference the tokens — no scattered magic-number durations
// ===========================================================================
describe('components consult the central tokens, not magic numbers', () => {
  it('StagePipeline carries no inline ms durations (uses the dot classes)', () => {
    const s = read('components/forge/StagePipeline.tsx');
    expect(s).toMatch(/forge-stage-dot/);
    expect(s).not.toMatch(/\d+ms/); // duration lives in the CSS var
    expect(s).not.toMatch(/animate-pulse/); // no infinite pulse
  });

  // NOTE: the IntakeForm + MoldSpacePage + ProjectCard token-usage checks
  // have been retired alongside those components (deleted as orphans —
  // the AI-futuristic IntakeFormAi / MoldSpaceAi / ProjectCardAi cover
  // the live surfaces). The ForgeButton heat-bar check moved into the
  // primitive-coverage tests (forge-design-language.test.ts §3).
});

// ===========================================================================
// 2c. Hover/focus heat-glow consistent + reduced-motion-frozen
// ===========================================================================
describe('hover / focus heat-glow', () => {
  it('EmberCard hover uses the eased lift class (frozen by reduced-motion)', () => {
    const s = read('components/forge/EmberCard.tsx');
    expect(s).toMatch(/forge-lift/);
    expect(s).toMatch(/hover:border-heat-glow/);
  });

  it('ForgeButton loads with the heat-bar (used by un-migrated panels)', () => {
    const btn = read('components/forge/ForgeButton.tsx');
    expect(btn).toMatch(/forge-heat-bar/);
    expect(btn).toMatch(/active:/);
  });

  it('text inputs share ONE focus heat-glow rule in globals.css', () => {
    const css = read('app/globals.css');
    // The shared rule targets textarea + text inputs and warms with the
    // inner heat-glow on focus.
    expect(css).toMatch(/input\[type='text'\]:focus/);
    expect(css).toMatch(/border-color: var\(--heat-glow\)/);
    expect(css).toMatch(/box-shadow: inset 0 0 44px -14px rgba\(255, 154, 77/);
  });
});
