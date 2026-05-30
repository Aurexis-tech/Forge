// Hermetic structural tests for the shared visual foundation.
//
// No DOM test env, so these read the source of the shell + primitives and
// assert the brand foundation is wired: the atmospheric backdrop is
// mounted once for every app page ("no flat-black pages"), the Fraunces
// display font + token-backed heading face are in place, and the app
// pages compose the shared PageHeader (brand typography) + keep their
// hover/focus affordances. The components are thin JSX over these facts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// Atmosphere — one shared backdrop behind every app page
// ===========================================================================
describe('shared ForgeBackdrop', () => {
  const layout = read('app/(app)/layout.tsx');
  const backdrop = read('components/ForgeBackdrop.tsx');

  it('is served to un-migrated (app) routes via the AppBackdrop switch', () => {
    // The (app) layout now mounts the AppBackdrop switch (not ForgeBackdrop
    // directly); AppBackdrop renders ForgeBackdrop + ForgeScene for every
    // un-migrated route, AurexisAmbient for migrated ones.
    expect(layout).toMatch(/<AppBackdrop\s*\/>/);
    const appBackdrop = read('components/lq/AppBackdrop.tsx');
    expect(appBackdrop).toMatch(/<ForgeBackdrop\s*\/>/);
    expect(appBackdrop).toMatch(/<ForgeScene\s*\/>/);
    expect(appBackdrop).toMatch(/isMigratedRoute/);
  });

  it('renders the lattice + breathing glow + embers + vignette in brand tokens', () => {
    // Lattice grid lines.
    expect(backdrop).toMatch(/linear-gradient/);
    // Breathing molten glow (amber + cyan radial), brand rgba values.
    expect(backdrop).toMatch(/radial-gradient/);
    expect(backdrop).toMatch(/255,154,77/); // amber glow
    // The breathe animation hook + a vignette into the void.
    expect(backdrop).toMatch(/forge-ambient-breathe/);
    expect(backdrop).toMatch(/5,6,10/); // forge-void vignette
    // The signature: rising embers reuse the landing's ember keyframe.
    expect(backdrop).toMatch(/forge-css-ember/);
    expect(backdrop).toMatch(/--ember-lift/);
    // Non-interactive, sits behind content.
    expect(backdrop).toMatch(/pointer-events-none/);
    expect(backdrop).toMatch(/-z-10/);
  });
});

// ===========================================================================
// Typography — Fraunces display face, globally inherited
// ===========================================================================
describe('brand display typography', () => {
  it('root layout loads the brand fonts via next/font and exposes their vars', () => {
    const root = read('app/layout.tsx');
    expect(root).toMatch(/from 'next\/font\/google'/);
    expect(root).toMatch(/Fraunces\(/);
    expect(root).toMatch(/Spectral\(/);
    expect(root).toMatch(/IBM_Plex_Mono\(/);
    expect(root).toMatch(/variable:\s*'--font-display'/);
    expect(root).toMatch(/variable:\s*'--font-body'/);
    expect(root).toMatch(/variable:\s*'--font-mono'/);
    expect(root).toMatch(/display\.variable/);
  });

  it('tailwind exposes a display family backed by the font variable', () => {
    const tw = read('tailwind.config.ts');
    expect(tw).toMatch(/display:\s*\[/);
    expect(tw).toMatch(/var\(--font-display\)/);
  });

  it('globals.css points headings at the display face (every page inherits)', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/h1,\s*\n?\s*h2,\s*\n?\s*h3\s*\{/);
    expect(css).toMatch(/font-family:\s*var\(--font-display\)/);
  });

  it('keeps a brand focus ring (amber) for inputs/controls', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/#ff9a4d/);
  });
});

// ===========================================================================
// SectionHeader — the shared eyebrow → serif title rhythm
// ===========================================================================
describe('SectionHeader primitive', () => {
  const src = read('components/forge/SectionHeader.tsx');

  it('renders a cyan mono eyebrow + a serif title (h1 or h2 via global rule)', () => {
    expect(src).toMatch(/tracking-\[0\.5em\]/);
    expect(src).toMatch(/text-forge-cyan/);
    expect(src).toMatch(/Heading/); // h1/h2 by level
    expect(src).toMatch(/text-3xl/);
  });
});

// NOTE: the per-page foundation assertions (SectionHeader / Reveal /
// max-w-5xl on the mold spaces, the ProjectCard heat-glow hover, and
// the Reveal reduced-motion check) have been retired alongside the
// forge page components they read (MoldSpacePage / ProjectCard / Reveal —
// deleted as orphans once the AI-futuristic mold-space + project-card +
// reveal surfaces took over). The live SectionHeader primitive coverage
// stays in this file (above); per-page composition is now exercised by
// the AI suites (projects-ai.test.ts, mold-space-ai.test.ts).
