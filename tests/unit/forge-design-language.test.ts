// Hermetic structural tests for the FORGE design language foundation.
//
// No DOM test env, so these read source: the documented language, the
// heat-spectrum tokens, the 5 primitives' characteristic classes, the
// intake showcase wiring, and that motion is governed by reduced-motion
// (the global kill-switch + class-based motion the primitives use).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. The documented design language exists, with the required sections
// ===========================================================================
describe('/docs/design-language.md', () => {
  const doc = read('docs/design-language.md');

  it('captures the philosophy (forging-as-a-moment, heat with restraint)', () => {
    expect(doc).toMatch(/moment of forging/i);
    expect(doc).toMatch(/restraint/i);
    expect(doc).toMatch(/never amber-everywhere/i);
  });

  it('documents the heat spectrum + cool palette with values', () => {
    expect(doc).toMatch(/heat spectrum/i);
    for (const t of ['--heat-coal', '--heat-ember', '--heat-glow', '--heat-molten', '--heat-spark']) {
      expect(doc, t).toContain(t);
    }
    expect(doc).toContain('--cool-cyan');
    expect(doc).toContain('#ff9a4d'); // the anchor value
  });

  it('documents typography, motion, component vocabulary, and what NOT to do', () => {
    expect(doc).toMatch(/Fraunces/);
    expect(doc).toMatch(/Spectral/);
    expect(doc).toMatch(/IBM Plex Mono/);
    expect(doc).toMatch(/Motion vocabulary/i);
    expect(doc).toMatch(/Embers/i);
    expect(doc).toMatch(/Component vocabulary/i);
    expect(doc).toMatch(/ForgeButton/);
    expect(doc).toMatch(/StagePipeline/);
    expect(doc).toMatch(/What NOT to do/i);
  });
});

// ===========================================================================
// 2. Heat-spectrum tokens resolve as CSS variables + Tailwind colors
// ===========================================================================
describe('heat spectrum tokens', () => {
  it('globals.css defines the heat spectrum + cool + neutral variables', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/--heat-coal:\s*#7a3b12/);
    expect(css).toMatch(/--heat-ember:\s*#c2611f/);
    expect(css).toMatch(/--heat-glow:\s*#ff9a4d/);
    expect(css).toMatch(/--heat-molten:\s*#ffba73/);
    expect(css).toMatch(/--heat-spark:\s*#ffe6c7/);
    expect(css).toMatch(/--cool-cyan:\s*#4fd4f0/);
    expect(css).toMatch(/--line:/);
  });

  it('tailwind surfaces heat.* / cool.* backed by the variables', () => {
    const tw = read('tailwind.config.ts');
    expect(tw).toMatch(/heat:\s*\{/);
    expect(tw).toMatch(/glow:\s*'var\(--heat-glow\)'/);
    expect(tw).toMatch(/molten:\s*'var\(--heat-molten\)'/);
    expect(tw).toMatch(/cool:\s*\{/);
    expect(tw).toMatch(/cyan:\s*'var\(--cool-cyan\)'/);
  });
});

// ===========================================================================
// 3. The 5 primitives render with their expected classes
// ===========================================================================
describe('the 5 forge primitives', () => {
  it('SectionHeader: cyan mono eyebrow + display heading', () => {
    const s = read('components/forge/SectionHeader.tsx');
    expect(s).toMatch(/tracking-\[0\.5em\]/);
    expect(s).toMatch(/text-forge-cyan/);
    expect(s).toMatch(/level === 1 \? 'h1' : 'h2'/);
  });

  it('HeatBadge: hairline mono pill + heat-spectrum tones', () => {
    const s = read('components/forge/HeatBadge.tsx');
    expect(s).toMatch(/HEAT_TONES/);
    expect(s).toMatch(/border-heat-glow/);
    expect(s).toMatch(/border-cool-cyan/);
    expect(s).toMatch(/rounded-full border/);
    expect(s).toMatch(/font-mono/);
  });

  it('ForgeButton: heat-glow action, hotter on hover + active (client)', () => {
    const s = read('components/forge/ForgeButton.tsx');
    expect(s).toMatch(/^'use client'/m);
    expect(s).toMatch(/border-heat-glow/);
    expect(s).toMatch(/bg-heat-glow/);
    expect(s).toMatch(/hover:shadow-/);
    expect(s).toMatch(/active:/);
    // Transition-based (the reduced-motion rule freezes it to solid); no
    // infinite keyframe of its own.
    expect(s).toMatch(/transition/);
    expect(s).not.toMatch(/animate-(pulse|spin|bounce|ping)/);
  });

  it('EmberCard: hairline surface + optional warm/cool inner ember', () => {
    const s = read('components/forge/EmberCard.tsx');
    expect(s).toMatch(/var\(--line\)/);
    expect(s).toMatch(/warm/);
    expect(s).toMatch(/cool/);
    expect(s).toMatch(/255,154,77/); // warm ember rgba
    expect(s).toMatch(/79,212,240/); // cool ember rgba
  });

  it('StagePipeline: cooling progression (molten active, cyan cooled, dim pending)', () => {
    const s = read('components/forge/StagePipeline.tsx');
    expect(s).toMatch(/CANONICAL_STAGES/);
    expect(s).toMatch(/bg-heat-molten/); // active = molten
    expect(s).toMatch(/bg-cool-cyan/); // completed = cooled
    expect(s).toMatch(/text-forge-faint/); // pending = dim
    expect(s).toMatch(/animate-pulse/); // active dot pulses (reduced-motion freezes)
    expect(s).toMatch(/Intent/);
    expect(s).toMatch(/Live/);
  });
});

// ===========================================================================
// 4. Intake showcase composes the primitives + the new structure
// ===========================================================================
describe('intake showcase', () => {
  const src = read('components/IntakeForm.tsx');

  it('composes SectionHeader + ForgeButton + EmberCard + StagePipeline', () => {
    expect(src).toMatch(/SectionHeader/);
    expect(src).toMatch(/<ForgeButton/);
    expect(src).toMatch(/<EmberCard/);
    expect(src).toMatch(/<StagePipeline/);
  });

  it('pipeline starts at INTENT (active index 0 — molten, rest dim)', () => {
    expect(src).toMatch(/activeIndex=\{0\}/);
  });

  it('the describe box gets a heat-glow only on FOCUS (calm until you act)', () => {
    expect(src).toMatch(/focus:border-heat-glow/);
    expect(src).toMatch(/focus:shadow-\[inset/);
  });

  it('starter chips carry a restrained heat tint on hover only', () => {
    expect(src).toMatch(/hover:border-heat-glow\/30/);
  });
});

// ===========================================================================
// 5. Motion is governed by prefers-reduced-motion
// ===========================================================================
describe('reduced-motion governance', () => {
  it('globals.css zeroes animation + transition durations under reduced-motion', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(css).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });

  it('the backdrop embers + breathe use class-based motion the rule freezes', () => {
    const b = read('components/ForgeBackdrop.tsx');
    expect(b).toMatch(/forge-css-ember/); // cancelled by the global rule
    expect(b).toMatch(/forge-ambient-breathe/); // cancelled by the global rule
  });
});
