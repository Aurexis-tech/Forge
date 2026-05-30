// Hermetic tests for the DORMANT AI-futuristic design language.
//
// House style: the repo's test env is node-only (no jsdom / render lib),
// so DOM components are verified by (a) unit-testing the PURE logic they
// wrap and (b) asserting their source wiring + the exact material spec —
// the same approach the forge-* design tests use. The governing rule for
// this whole foundation: NOTHING changed about the live forge look, and
// nothing new is mounted yet.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SPECULAR_RESET,
  specularOffset,
} from '@/components/lq/useSpecular';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. New colour tokens resolve — and the forge ink set is UNTOUCHED
// ===========================================================================
describe('AI-futuristic tokens in globals.css', () => {
  const css = read('app/globals.css');

  it('defines every new colour + easing token', () => {
    for (const [name, value] of [
      ['--void', '#08090d'],
      ['--elev-1', '#0e1018'],
      ['--elev-2', '#14171f'],
      ['--ink-base', '#f0f2f8'],
      ['--ink-dim', '#9aa0b0'],
      ['--ink-faint', '#5a5f6e'],
      ['--ink-ghost', '#353841'],
      ['--aurora', '#5fe6ff'],
      ['--violet', '#a78bfa'],
      ['--amber', '#fbbf24'],
      ['--mint', '#6ee7b7'],
      ['--rose', '#fb7185'],
    ]) {
      expect(css, name).toContain(`${name}: ${value}`);
    }
    expect(css).toContain('--grid: rgba(255, 255, 255, 0.012)');
    expect(css).toMatch(/--ease:\s*cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
    expect(css).toMatch(/--ease-out:\s*cubic-bezier\(0\.22, 0\.61, 0\.36, 1\)/);
  });

  it('does NOT overwrite the forge ink set (collision resolved via --ink-base)', () => {
    // The forge --ink stays its original value; the new ink lives in
    // --ink-base. There must be no --ink: #f0f2f8 anywhere.
    expect(css).toMatch(/--ink:\s*#e7ecf3/); // forge value intact
    expect(css).not.toMatch(/--ink:\s*#f0f2f8/); // new value did NOT clobber it
    expect(css).toContain('--ink-base: #f0f2f8');
  });

  it('reuses the forge --line (identical value, no --line-base needed)', () => {
    expect(css).toMatch(/--line:\s*rgba\(255, 255, 255, 0\.08\)/);
    // No --line-base DECLARATION (the prose comment may mention the name).
    expect(css).not.toMatch(/--line-base\s*:/);
  });

  it('leaves the forge heat spectrum exactly as it was', () => {
    expect(css).toContain('--heat-glow: #ff9a4d');
    expect(css).toContain('--heat-molten: #ffba73');
    expect(css).toContain('--cool-cyan: #4fd4f0');
  });
});

// ===========================================================================
// 2. Tailwind surfaces the new tokens WITHOUT clobbering defaults/forge
// ===========================================================================
describe('tailwind.config.ts — namespaced lq.* + new fonts', () => {
  const tw = read('tailwind.config.ts');

  it('adds an lq.* colour group backed by the new vars', () => {
    expect(tw).toMatch(/lq:\s*\{/);
    expect(tw).toMatch(/void:\s*'var\(--void\)'/);
    expect(tw).toMatch(/aurora:\s*'var\(--aurora\)'/);
    expect(tw).toMatch(/violet:\s*'var\(--violet\)'/);
    expect(tw).toMatch(/rose:\s*'var\(--rose\)'/);
    expect(tw).toMatch(/amber:\s*'var\(--amber\)'/);
    expect(tw).toMatch(/ink:\s*'var\(--ink-base\)'/);
  });

  it('keeps the forge colour groups intact', () => {
    expect(tw).toMatch(/forge:\s*\{/);
    expect(tw).toMatch(/heat:\s*\{/);
    expect(tw).toMatch(/cool:\s*\{/);
  });

  it('adds font-ui (Inter) + font-code (JetBrains) without touching the forge faces', () => {
    expect(tw).toMatch(/ui:\s*\[\s*'var\(--font-ui\)'/);
    expect(tw).toMatch(/code:\s*\[\s*'var\(--font-code\)'/);
    expect(tw).toMatch(/display:\s*\[\s*'var\(--font-display\)'/);
    expect(tw).toMatch(/mono:\s*\[\s*'var\(--font-mono\)'/);
  });
});

// ===========================================================================
// 3. Fonts wired (dormant) in the root layout
// ===========================================================================
describe('app/layout.tsx — new fonts added, forge fonts untouched', () => {
  const layout = read('app/layout.tsx');

  it('loads Inter + JetBrains Mono via next/font with the new var names', () => {
    expect(layout).toMatch(/Inter,/);
    expect(layout).toMatch(/JetBrains_Mono,/);
    expect(layout).toMatch(/variable:\s*'--font-ui'/);
    expect(layout).toMatch(/variable:\s*'--font-code'/);
  });

  it('exposes the new vars on <html> alongside the forge font vars', () => {
    expect(layout).toMatch(/ui\.variable/);
    expect(layout).toMatch(/code\.variable/);
    expect(layout).toMatch(/display\.variable/);
    expect(layout).toMatch(/body\.variable/);
    expect(layout).toMatch(/mono\.variable/);
  });

  it('the body still wears the forge body font (nothing flipped)', () => {
    expect(layout).toMatch(/font-body/);
  });
});

// ===========================================================================
// 4. useSpecular — PURE pointer math (verified, not just asserted to exist)
// ===========================================================================
describe('useSpecular specular math', () => {
  it('specularOffset returns px offsets from the element rect', () => {
    expect(specularOffset({ left: 100, top: 50 }, 150, 80)).toEqual({
      mx: 50,
      my: 30,
    });
    expect(specularOffset({ left: 0, top: 0 }, 0, 0)).toEqual({ mx: 0, my: 0 });
    expect(specularOffset({ left: 200, top: 200 }, 180, 240)).toEqual({
      mx: -20,
      my: 40,
    });
  });

  it('resets to the centre (50%/50%)', () => {
    expect(SPECULAR_RESET).toEqual({ mx: '50%', my: '50%' });
  });

  it('the hook is SSR-safe + wires pointermove/leave to --mx/--my', () => {
    const s = read('components/lq/useSpecular.ts');
    expect(s).toMatch(/^'use client'/m);
    expect(s).toMatch(/typeof window === 'undefined'/); // SSR guard
    expect(s).toMatch(/addEventListener\('pointermove'/);
    expect(s).toMatch(/addEventListener\('pointerleave'/);
    expect(s).toMatch(/setProperty\('--mx'/);
    expect(s).toMatch(/setProperty\('--my'/);
  });
});

// ===========================================================================
// 5. LiquidGlass — variants, specular wiring, disabled is inert
// ===========================================================================
describe('LiquidGlass component', () => {
  const src = read('components/lq/LiquidGlass.tsx');
  const css = read('components/lq/LiquidGlass.module.css');

  it("is a client component that maps each variant to its module class", () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/import\s+styles\s+from\s+'\.\/LiquidGlass\.module\.css'/);
    expect(src).toMatch(/aurora:\s*styles\.aurora/);
    expect(src).toMatch(/rose:\s*styles\.rose/);
    expect(src).toMatch(/disabled:\s*styles\.disabled/);
  });

  it('drives the specular via useSpecular — and SKIPS it when disabled', () => {
    expect(src).toMatch(/useSpecular/);
    expect(src).toMatch(/const isDisabled = variant === 'disabled'/);
    expect(src).toMatch(/useSpecular<HTMLElement>\(!isDisabled\)/);
  });

  it('a disabled surface is not a focusable action', () => {
    expect(src).toMatch(/disabled:\s*true/); // real <button> gets disabled
    expect(src).toMatch(/'aria-disabled':\s*true/);
    expect(src).toMatch(/tabIndex:\s*-1/);
  });

  it('LiquidGlassButton renders as a button with the button sizing class', () => {
    expect(src).toMatch(/export function LiquidGlassButton/);
    expect(src).toMatch(/as="button"/);
    expect(src).toMatch(/styles\.button/);
  });

  it('the glass material matches the spec exactly', () => {
    expect(css).toMatch(/background:\s*rgba\(255, 255, 255, 0\.05\)/);
    expect(css).toMatch(/backdrop-filter:\s*blur\(24px\) saturate\(180%\)/);
    expect(css).toMatch(/border:\s*1px solid rgba\(255, 255, 255, 0\.16\)/);
    expect(css).toMatch(/border-radius:\s*14px/);
    expect(css).toMatch(/inset 0 1px 0 rgba\(255, 255, 255, 0\.18\)/);
    expect(css).toMatch(/inset 0 -1px 0 rgba\(0, 0, 0, 0\.22\)/);
    expect(css).toMatch(/0 8px 24px rgba\(0, 0, 0, 0\.3\)/);
    expect(css).toMatch(/0\.35s var\(--ease\)/);
  });

  it('the ::before wet edge + ::after cursor-tracking specular are wired', () => {
    expect(css).toMatch(/\.glass::before/);
    expect(css).toMatch(/rgba\(255, 255, 255, 0\.55\) 50%/);
    expect(css).toMatch(/\.glass::after/);
    expect(css).toMatch(/240px circle at var\(--mx, 50%\) var\(--my, 50%\)/);
    expect(css).toMatch(/\.glass:hover::after\s*\{\s*opacity:\s*1/);
  });

  it('hover lifts, active settles, aurora/rose/disabled variants are correct', () => {
    expect(css).toMatch(/\.glass:hover[\s\S]*transform:\s*translateY\(-1px\)/);
    expect(css).toMatch(/\.glass:active[\s\S]*transform:\s*translateY\(0\)/);
    expect(css).toMatch(/\.glass:active[\s\S]*rgba\(255, 255, 255, 0\.12\)/);
    // aurora primary
    expect(css).toMatch(/rgba\(95, 230, 255, 0\.22\)/);
    expect(css).toMatch(/border-color:\s*rgba\(95, 230, 255, 0\.45\)/);
    expect(css).toMatch(/color:\s*#031318/);
    // rose destructive
    expect(css).toMatch(/\.rose[\s\S]*color:\s*var\(--rose\)/);
    // disabled inert: no specular, not-allowed
    expect(css).toMatch(/\.disabled[\s\S]*cursor:\s*not-allowed/);
    expect(css).toMatch(/\.disabled::before,\s*\.disabled::after\s*\{\s*display:\s*none/);
    // button sizing
    expect(css).toMatch(/\.button[\s\S]*padding:\s*16px 24px/);
    expect(css).toMatch(/\.button[\s\S]*font-family:\s*var\(--font-ui\)/);
    expect(css).toMatch(/\.button[\s\S]*font-size:\s*15px/);
  });

  it('honors reduced-motion (drops the transform lift)', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/transform:\s*none/);
  });
});

// ===========================================================================
// 6. AurexisAmbient — "Deep field" direction, LIVE on every migrated route
// ===========================================================================
describe('AurexisAmbient — Deep field backdrop', () => {
  const src = read('components/lq/AurexisAmbient.tsx');
  const css = read('components/lq/AurexisAmbient.module.css');

  it('renders the 4 deep-field layers (starfield + focus glow + grain + vignette)', () => {
    expect(src).toMatch(/styles\.ambient/);
    expect(src).toMatch(/styles\.starfield/);
    expect(src).toMatch(/styles\.focus/);
    expect(src).toMatch(/styles\.grain/);
    expect(src).toMatch(/styles\.vignette/);
  });

  it('DROPS the 12-col grid (deep field is minimal — no lattice)', () => {
    // The grid layer + its --grid token usage are gone; a lattice over a
    // starfield reads busy, against the deep-field intent.
    expect(src).not.toMatch(/styles\.grid\b/);
    expect(css).not.toMatch(/var\(--grid\)/);
  });

  it('the base is a deepened near-black (darker than --void) so the field reads', () => {
    expect(css).toMatch(/background:\s*#060709/);
  });

  it('the starfield is static layered radial-gradient dots (no images, no twinkle)', () => {
    // Many 1px radial-gradient points, mostly white + a couple aurora,
    // tiled via background-size. No url() image, no animation on it.
    const dotCount = (css.match(/radial-gradient\(1px 1px at/g) ?? []).length;
    expect(dotCount).toBeGreaterThanOrEqual(8);
    expect(css).toMatch(/\.starfield[\s\S]*?var\(--aurora\)/); // a couple aurora dots
    expect(css).toMatch(/\.starfield[\s\S]*?background-size:/);
    // The starfield block must NOT carry an animation (static).
    const starBlock = css.match(/\.starfield\s*\{[\s\S]*?\}/);
    expect(starBlock, 'starfield block present').toBeTruthy();
    expect(starBlock![0]).not.toMatch(/animation/);
  });

  it('the focus glow is a single centred aurora bloom, heavily blurred (~680×520, blur 140px)', () => {
    expect(css).toMatch(/\.focus[\s\S]*?radial-gradient[\s\S]*?var\(--aurora\)/);
    expect(css).toMatch(/width:\s*680px/);
    expect(css).toMatch(/height:\s*520px/);
    expect(css).toMatch(/filter:\s*blur\(140px\)/);
  });

  it('the grain layer is an inline SVG noise tile, low-opacity overlay blend', () => {
    expect(css).toMatch(/mix-blend-mode:\s*overlay/);
    expect(css).toMatch(/feTurbulence/);
    expect(css).toMatch(/opacity:\s*0\.04/);
  });

  it('the vignette is a strong radial with a tight transparent centre (~38%)', () => {
    expect(css).toMatch(/radial-gradient\([\s\S]*?transparent\s+38%/);
    expect(css).toMatch(/rgba\(2,\s*3,\s*5,\s*0?\.85\)/);
  });

  it('has exactly ONE infinite loop (focusBreathe), scoped to the module', () => {
    // Strip CSS comments before counting so the module's own prose
    // header can't accidentally match (same pattern as keys-ai /
    // landing-ai). The deep field is calmer — one loop, not two.
    const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const infinites = cssNoComments.match(/animation[^;]*infinite/g) ?? [];
    expect(infinites.length).toBe(1);
    expect(css).toMatch(/@keyframes focusBreathe/);
    expect(css).toMatch(/animation:\s*focusBreathe\s+9s/);
    // Opacity-only breathe — no movement (no translate in the keyframe).
    const kf = css.match(/@keyframes focusBreathe\s*\{[\s\S]*?\}\s*\}/);
    expect(kf, 'focusBreathe keyframe present').toBeTruthy();
    expect(kf![0]).not.toMatch(/translate/);
    // The retired drift loops are fully gone.
    expect(css).not.toMatch(/auroraDrift/);
    expect(css).not.toMatch(/violetDrift/);
  });

  it('respects prefers-reduced-motion at the module level (breathe disabled)', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const reducedBlock = css.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\}\s*\}/,
    );
    expect(reducedBlock, 'reduced-motion block must be present').toBeTruthy();
    expect(reducedBlock![0]).toMatch(/animation:\s*none/);
  });

  it('keeps its keyframes OUT of globals.css (live enforcer stays ≤4)', () => {
    const g = read('app/globals.css');
    // Neither the current name nor any retired backdrop keyframe leaks in.
    expect(g).not.toMatch(/focusBreathe/);
    expect(g).not.toMatch(/auroraDrift/);
    expect(g).not.toMatch(/violetDrift/);
    expect(g).not.toMatch(/auroraBreathe/);
    expect(g).not.toMatch(/violetBreathe/);
    const liveInfinites = g.match(/animation[^;]*infinite/g) ?? [];
    expect(liveInfinites.length).toBeLessThanOrEqual(4); // mirrors forge-motion enforcer
  });
});

// ===========================================================================
// 7. GUARD — nothing flipped: ForgeBackdrop is still the mounted backdrop
// ===========================================================================
describe('un-migrated (app) routes still get the forge backdrop (via the switch)', () => {
  // The foundation is no longer dormant: the Intake migration mounts the
  // AppBackdrop switch in the (app) layout. The forge backdrop is still
  // served to every un-migrated route through that switch; AurexisAmbient
  // only renders on the migrated branch.
  const appBackdrop = read('components/lq/AppBackdrop.tsx');

  it('AppBackdrop renders ForgeBackdrop + ForgeScene for un-migrated routes', () => {
    expect(appBackdrop).toMatch(/<ForgeBackdrop\s*\/>/);
    expect(appBackdrop).toMatch(/<ForgeScene\s*\/>/);
    expect(appBackdrop).toMatch(/isMigratedRoute/);
  });

  it('and AurexisAmbient only on the migrated branch', () => {
    expect(appBackdrop).toMatch(/<AurexisAmbient\s*\/>/);
  });
});
