// Hermetic tests for the AI-futuristic Landing migration. House style:
// node-only, pure-logic + source assertions (like the foundation tests).
// Verifies the demo SCRIPT (pure), the page wiring, the scoped backdrop
// swap (Landing → AurexisAmbient; (app) → still ForgeBackdrop), the
// reduced-motion static path, and that the new infinite loops are scoped
// (globals.css enforcer stays at 4).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEMO_INTENT,
  DEMO_LIVE_INDEX,
  DEMO_STAGES,
  MOLD_SHOWCASE,
  demoFinalState,
} from '@/lib/landing-demo';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. The demo SCRIPT is pure + correct
// ===========================================================================
describe('lib/landing-demo — the pipeline script', () => {
  it('is the canonical 8-dot pipeline in order', () => {
    expect(DEMO_STAGES).toHaveLength(8);
    expect(DEMO_STAGES.map((s) => s.id)).toEqual([
      'intent',
      'spec',
      'plan',
      'code',
      'sandbox',
      'repo',
      'deploy',
      'live',
    ]);
  });

  it('flags Repo as the human-decision GATE (amber) and Live as terminal (mint)', () => {
    const repo = DEMO_STAGES.find((s) => s.id === 'repo')!;
    const live = DEMO_STAGES.find((s) => s.id === 'live')!;
    expect(repo.gate).toBe(true);
    expect(repo.tone).toBe('amber');
    expect(live.terminal).toBe(true);
    expect(live.tone).toBe('mint');
    expect(DEMO_LIVE_INDEX).toBe(7);
  });

  it('carries timings for Spec→Live and a card for every non-intent stage', () => {
    for (const s of DEMO_STAGES.filter((x) => x.id !== 'intent')) {
      expect(s.durationMs, s.id).toBeGreaterThan(0);
      expect(s.card, s.id).toBeTruthy();
    }
    // Code streams a filename.
    expect(DEMO_STAGES.find((s) => s.id === 'code')!.streaming).toBe(true);
  });

  it('the typed intent is the arXiv brief line', () => {
    expect(DEMO_INTENT).toContain('arXiv');
    expect(DEMO_INTENT).toContain('5-bullet brief');
    expect(DEMO_INTENT).toContain('07:00');
  });

  it('demoFinalState is the settled LIVE state (reduced-motion target)', () => {
    const f = demoFinalState();
    expect(f.typed).toBe(DEMO_INTENT);
    expect(f.moldDetected).toBe(true);
    expect(f.activeIndex).toBe(DEMO_LIVE_INDEX);
    expect(f.done).toBe(true);
    expect(f.card).toBe(DEMO_STAGES[DEMO_LIVE_INDEX]!.card);
  });
});

// ===========================================================================
// 2. Mold showcase data — front-door gallery (examples, not a library count)
// ===========================================================================
describe('MOLD_SHOWCASE gallery', () => {
  it('has the four molds with their accents + real mold-space hrefs', () => {
    expect(MOLD_SHOWCASE).toHaveLength(4);
    expect(MOLD_SHOWCASE.map((m) => m.accent)).toEqual([
      'aurora',
      'violet',
      'mint',
      'amber',
    ]);
    expect(MOLD_SHOWCASE.map((m) => m.href)).toEqual([
      '/agents',
      '/systems',
      '/software',
      '/infrastructure',
    ]);
  });

  it('shows the four representative examples + 3 illustrative stats each', () => {
    const examples = MOLD_SHOWCASE.map((m) => m.example);
    expect(examples).toContain('arxiv-morning-brief');
    expect(examples).toContain('competitor-watch');
    expect(examples).toContain('expense-flow');
    expect(examples).toContain('team-postgres');
    for (const m of MOLD_SHOWCASE) expect(m.stats).toHaveLength(3);
  });
});

// ===========================================================================
// 3. Landing page wiring
// ===========================================================================
describe('app/page.tsx — migrated Landing', () => {
  const page = read('app/page.tsx');

  it('mounts AurexisAmbient + composes AiNav + LiveDemo + MoldShowcase', () => {
    expect(page).toMatch(/import\s*\{\s*AurexisAmbient\s*\}/);
    expect(page).toMatch(/<AurexisAmbient\s*\/>/);
    expect(page).toMatch(/import\s*\{\s*AiNav\s*\}/);
    expect(page).toMatch(/<AiNav\s*\/>/);
    expect(page).toMatch(/<LiveDemo\s*\/>/);
    expect(page).toMatch(/<MoldShowcase\s*\/>/);
    expect(page).toMatch(/LiquidGlass/);
  });

  it('uses the lq.* tokens + the new UI font (no forge tokens)', () => {
    expect(page).toMatch(/text-lq-ink/);
    expect(page).toMatch(/text-lq-aurora/);
    expect(page).toMatch(/font-ui/);
    expect(page).not.toMatch(/forge-amber|bg-forge-void|font-display/);
  });

  it('CTAs target real existing routes', () => {
    expect(page).toMatch(/href="\/forge"/); // start a forge → intake
    expect(page).toMatch(/href="#molds"/); // see examples → gallery anchor
  });
});

// ===========================================================================
// 4. AiNav — the reusable new nav
// ===========================================================================
describe('components/lq/AiNav', () => {
  const nav = read('components/lq/AiNav.tsx');

  it('renders the brand dot + center links to real routes + a LiquidGlass action', () => {
    expect(nav).toMatch(/brandDot/);
    expect(nav).toMatch(/LiquidGlass/);
    expect(nav).toMatch(/'\/forge'/);
    expect(nav).toMatch(/'\/projects'/);
    expect(nav).toMatch(/'\/settings\/keys'/);
    expect(nav).toMatch(/'\/governance'/);
    expect(nav).toMatch(/font-ui/);
  });
});

// ===========================================================================
// 5. LiveDemo — JS state machine + reduced-motion static path
// ===========================================================================
describe('components/landing-ai/LiveDemo', () => {
  const demo = read('components/landing-ai/LiveDemo.tsx');

  it('is a client component consuming the pure script', () => {
    expect(demo).toMatch(/^'use client'/m);
    expect(demo).toMatch(/from '@\/lib\/landing-demo'/);
    expect(demo).toMatch(/DEMO_STAGES/);
  });

  it('drives the cycle with a JS state machine (setTimeout), not infinite CSS', () => {
    expect(demo).toMatch(/setTimeout/);
    expect(demo).toMatch(/setActiveIndex/);
    // The only looping CSS it uses are the scoped pulse dot + cursor.
    expect(demo).toMatch(/styles\.pulseDot/);
    expect(demo).toMatch(/styles\.cursor/);
  });

  it('has the reduced-motion static-final-state path', () => {
    expect(demo).toMatch(/prefers-reduced-motion/);
    expect(demo).toMatch(/matchMedia/);
    expect(demo).toMatch(/demoFinalState\(\)/);
  });
});

// ===========================================================================
// 6. Scoped backdrop swap — Landing flips, (app) does NOT
// ===========================================================================
describe('scoped backdrop migration', () => {
  it('Landing mounts AurexisAmbient', () => {
    expect(read('app/page.tsx')).toMatch(/<AurexisAmbient\s*\/>/);
  });

  it('the (app) shell STILL mounts ForgeBackdrop and never AurexisAmbient', () => {
    const layout = read('app/(app)/layout.tsx');
    expect(layout).toMatch(/<ForgeBackdrop\s*\/>/);
    expect(layout).not.toMatch(/AurexisAmbient/);
  });
});

// ===========================================================================
// 7. Infinite-loop discipline — new loops are SCOPED to modules, not globals
// ===========================================================================
describe('infinite-animation budget stays honest', () => {
  // Count real `animation:…infinite` DECLARATIONS, ignoring prose in CSS
  // comments (which can otherwise contain the words "infinite animations").
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the landing module has exactly TWO infinite loops (pulse dot + cursor)', () => {
    expect(countInfinite('components/landing-ai/landing.module.css')).toBe(2);
  });

  it('the AiNav module has exactly ONE infinite loop (brand dot)', () => {
    expect(countInfinite('components/lq/AiNav.module.css')).toBe(1);
  });

  it('globals.css is unchanged — still ≤4 infinite loops', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    // The new landing keyframes never leaked into globals.css.
    expect(read('app/globals.css')).not.toMatch(/demoPulse|demoBlink|navPulse/);
  });
});
