// Hermetic tests for the mold-agnostic intake copy + starters.
//
// No DOM test env (vitest + node), so — like the other UI tests — these
// cover the PURE content the IntakeForm renders (INTAKE_COPY +
// INTAKE_EXAMPLES) plus a STRUCTURAL check on the component source proving
// the flow is unchanged: one describe box, no mold picker, the request
// carries only the raw prompt (the engine still auto-detects).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTAKE_COPY, INTAKE_EXAMPLES } from '@/lib/intake-content';
import { PROJECT_MOLDS } from '@/lib/molds';

// ===========================================================================
// Copy is mold-agnostic
// ===========================================================================
describe('intake copy — mold-agnostic', () => {
  it('heading is build-framed, not agent-only', () => {
    expect(INTAKE_COPY.heading).toBe('Describe what you want to build');
    expect(INTAKE_COPY.heading).not.toMatch(/\bagent\b/i);
  });

  it('subcopy keeps the spec→…→live-URL promise', () => {
    expect(INTAKE_COPY.subcopy).toMatch(/structured spec/i);
    expect(INTAKE_COPY.subcopy).toMatch(/tested sandbox/i);
    expect(INTAKE_COPY.subcopy).toMatch(/live URL/i);
  });

  it('subcopy names all four molds + the auto-detection', () => {
    expect(INTAKE_COPY.subcopy).toMatch(/\bagent\b/i);
    expect(INTAKE_COPY.subcopy).toMatch(/multi-agent system|system/i);
    expect(INTAKE_COPY.subcopy).toMatch(/full app|software/i);
    expect(INTAKE_COPY.subcopy).toMatch(/infrastructure/i);
    expect(INTAKE_COPY.subcopy).toMatch(/detects? which/i);
  });

  it('aria-label + empty-error are not agent-only', () => {
    expect(INTAKE_COPY.ariaLabel).not.toMatch(/\bagent\b/i);
    expect(INTAKE_COPY.emptyError).not.toMatch(/\bagent\b/i);
    expect(INTAKE_COPY.emptyError).toBe('Describe what you want to build first.');
  });
});

// ===========================================================================
// Starters span the four molds
// ===========================================================================
describe('intake starters — one per mold', () => {
  it('there are exactly four starters, one per canonical mold', () => {
    expect(INTAKE_EXAMPLES).toHaveLength(4);
    expect(INTAKE_EXAMPLES.map((e) => e.mold)).toEqual([...PROJECT_MOLDS]);
  });

  it('each starter has the exact span-the-range prompt', () => {
    const byMold = Object.fromEntries(
      INTAKE_EXAMPLES.map((e) => [e.mold, e.prompt]),
    );
    expect(byMold.agent).toBe(
      'A research assistant that scans new arXiv papers each morning and emails me a 5-bullet brief.',
    );
    expect(byMold.system).toBe(
      'A system that watches three competitors — one agent gathers news, one summarizes each source, one writes me a Monday briefing.',
    );
    expect(byMold.software).toBe(
      'A web app where my team submits expenses, a manager approves them, and everyone sees their own history.',
    );
    expect(byMold.infrastructure).toBe(
      'A pipeline that ingests events from my sources every hour, stores them, and serves them to my other tools.',
    );
  });

  it('every starter has a non-empty prompt + title (fills the box on click)', () => {
    for (const e of INTAKE_EXAMPLES) {
      expect(e.prompt.trim().length, e.mold).toBeGreaterThan(0);
      expect(e.title.trim().length, e.mold).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Flow untouched — unified intake, no picker, auto-detect preserved
// ===========================================================================
describe('intake flow — no mold picker, no preset (structural)', () => {
  const src = readFileSync('components/IntakeForm.tsx', 'utf8');

  it('consumes the shared mold-agnostic content', () => {
    expect(src).toMatch(/INTAKE_COPY/);
    expect(src).toMatch(/INTAKE_EXAMPLES/);
  });

  it('a starter click fills the describe box verbatim', () => {
    expect(src).toMatch(/setPrompt\(ex\.prompt\)/);
  });

  it('posts ONLY the raw prompt — never a mold/kind preset', () => {
    expect(src).toMatch(/raw_prompt: trimmed/);
    // No mold/kind is threaded into the request body — the engine
    // auto-detects from the prompt alone.
    expect(src).not.toMatch(/kind:/);
    expect(src).not.toMatch(/mold:/);
  });

  it('adds no mold picker (no <select>, no radio group)', () => {
    expect(src).not.toMatch(/<select/);
    expect(src).not.toMatch(/type="radio"/);
  });
});
