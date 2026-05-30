// Hermetic structural tests for the still-live FORGE design-language
// internals: heat-spectrum tokens, the 5 primitives, and reduced-motion
// governance. These primitives remain in use inside the un-migrated
// interior *Area panels on the project detail page; the doc + intake-
// showcase assertions have moved to the AI design-language doc and the
// AI intake test (the forge IntakeForm + the old doc structure have
// been retired alongside this prompt's orphan sweep).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

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
    // Motion discipline: the active dot warms ONCE on arrival (a bounded
    // single play), not an infinite pulse — see forge-motion.test.ts.
    expect(s).toMatch(/forge-stage-warm/);
    expect(s).not.toMatch(/animate-pulse/);
    expect(s).toMatch(/Intent/);
    expect(s).toMatch(/Live/);
  });
});

// NOTE: the intake showcase block (which read components/IntakeForm.tsx)
// has been retired alongside the forge IntakeForm — the live intake is
// now the AI-futuristic IntakeFormAi (see tests/unit/intake-ai.test.ts).

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
