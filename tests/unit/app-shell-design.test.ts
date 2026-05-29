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

// ===========================================================================
// Pages compose the shared foundation (not per-page duplication)
// ===========================================================================
describe('un-migrated pages still wear the shared forge foundation', () => {
  // Home (/projects) has MIGRATED to the AI-futuristic system and no longer
  // uses SectionHeader / Reveal / max-w-5xl. The mold spaces are still
  // forge-styled, so the foundation assertions still apply to them.
  const moldSpace = read('components/MoldSpacePage.tsx');

  it('mold spaces use SectionHeader (brand typography)', () => {
    expect(moldSpace).toMatch(/SectionHeader/);
  });

  it('mold spaces use Reveal (reveal-on-scroll motion)', () => {
    expect(moldSpace).toMatch(/Reveal/);
  });

  it('mold spaces constrain their column rhythm (max-width)', () => {
    expect(moldSpace).toMatch(/max-w-5xl/);
  });
});

// ===========================================================================
// Motion / affordances — hover + focus discipline preserved
// ===========================================================================
describe('hover + focus affordances', () => {
  it('project cards keep the heat-glow hover treatment (now an EmberCard)', () => {
    const card = read('components/ProjectCard.tsx');
    // Propagated to the forge language: EmberCard surface, heat-glow on hover.
    expect(card).toMatch(/EmberCard/);
    expect(card).toMatch(/group-hover:border-heat-glow/);
    expect(card).toMatch(/group-hover:shadow-amber/);
  });

  it('the New Forge action on un-migrated mold spaces uses amber + glow hover', () => {
    // /projects has migrated to the AI-futuristic system; the mold spaces
    // still wear the forge New Forge button.
    const moldSpace = read('components/MoldSpacePage.tsx');
    expect(moldSpace).toMatch(/text-forge-amber/);
    expect(moldSpace).toMatch(/hover:shadow-amber/);
  });

  it('Reveal is reduced-motion safe (content shown without motion)', () => {
    const reveal = read('components/Reveal.tsx');
    expect(reveal).toMatch(/prefers-reduced-motion/);
    expect(reveal).toMatch(/motion-reduce:transition-none/);
  });
});
