// Hermetic render tests for the show-spec gate's confidence UI.
//
// The project ships without a DOM test env (vitest + node). So
// rather than render the components to a virtual DOM, these tests
// cover the PURE HELPERS that the components consume:
//
//   - CONFIDENCE_PRESENTATION — per-level label + tone + glyph.
//   - buildUncertaintyStripItems — strip item ordering across
//     'missing' / 'guessed' / 'inferred', per-mold.
//   - levelForField — backward-compatible lookup when confidence
//     is undefined.
//
// The components (ConfidenceBadge, UncertaintyStrip, *SpecView)
// are thin JSX wrappers over these helpers; once the helpers
// produce the right shapes, the components do the right thing by
// construction.

import { describe, expect, it } from 'vitest';
import {
  buildUncertaintyStripItems,
  CONFIDENCE_PRESENTATION,
  hasUncertainties,
  humaniseFieldName,
  levelForField,
  type SpecConfidence,
} from '@/components/spec/confidence-display';

// ===========================================================================
// PER-LEVEL VISUAL CONFIG MATRIX
// ===========================================================================
describe('CONFIDENCE_PRESENTATION matrix', () => {
  it("'stated' is low visual weight + reads 'from you'", () => {
    const p = CONFIDENCE_PRESENTATION.stated;
    expect(p.label).toBe('from you');
    expect(p.weight).toBe(0);
    // Subtle tone — uses dim/grey colour tokens, NOT the bright
    // amber/cyan/rose accent tokens.
    expect(p.toneClass).toMatch(/text-forge-dim/);
    expect(p.toneClass).not.toMatch(/text-rose/);
    expect(p.toneClass).not.toMatch(/text-forge-amber/);
  });

  it("'inferred' uses cyan tone, mid weight", () => {
    const p = CONFIDENCE_PRESENTATION.inferred;
    expect(p.label).toBe('inferred');
    expect(p.weight).toBe(1);
    expect(p.toneClass).toMatch(/text-forge-cyan/);
    expect(p.toneClass).toMatch(/border-forge-cyan/);
  });

  it("'guessed' uses amber tone, higher weight + reads 'guessed default'", () => {
    const p = CONFIDENCE_PRESENTATION.guessed;
    expect(p.label).toBe('guessed default');
    expect(p.weight).toBe(2);
    expect(p.toneClass).toMatch(/text-forge-amber/);
    expect(p.toneClass).toMatch(/border-forge-amber/);
  });

  it("'missing' uses rose tone, HIGHEST weight + reads 'missing — please specify'", () => {
    const p = CONFIDENCE_PRESENTATION.missing;
    expect(p.label).toBe('missing — please specify');
    expect(p.weight).toBe(3);
    expect(p.toneClass).toMatch(/text-rose/);
    expect(p.toneClass).toMatch(/border-rose/);
  });

  it('weights strictly ascend stated < inferred < guessed < missing', () => {
    const stated = CONFIDENCE_PRESENTATION.stated.weight;
    const inferred = CONFIDENCE_PRESENTATION.inferred.weight;
    const guessed = CONFIDENCE_PRESENTATION.guessed.weight;
    const missing = CONFIDENCE_PRESENTATION.missing.weight;
    expect(stated).toBeLessThan(inferred);
    expect(inferred).toBeLessThan(guessed);
    expect(guessed).toBeLessThan(missing);
  });
});

// ===========================================================================
// UNCERTAINTY STRIP ORDERING
// ===========================================================================
describe('buildUncertaintyStripItems — ordering by level then by leverage', () => {
  it('missing fields surface BEFORE guessed', () => {
    const confidence: SpecConfidence = {
      // software mold:
      //   entities (leverage 100): missing
      //   auth_per_user_isolation (leverage 90): guessed
      //   pages (leverage 90): missing
      entities: 'missing',
      auth_per_user_isolation: 'guessed',
      pages: 'missing',
    };
    const items = buildUncertaintyStripItems('software', confidence);
    // Both missing entries first, then guessed.
    expect(items[0]?.level).toBe('missing');
    expect(items[1]?.level).toBe('missing');
    expect(items[2]?.level).toBe('guessed');
    // Inside 'missing', leverage 100 (entities) precedes leverage 90 (pages).
    expect(items[0]?.field).toBe('entities');
    expect(items[1]?.field).toBe('pages');
  });

  it('guessed fields surface BEFORE inferred', () => {
    const confidence: SpecConfidence = {
      // agent mold:
      //   trigger (leverage 85): guessed
      //   capabilities (leverage 90): inferred
      trigger: 'guessed',
      capabilities: 'inferred',
    };
    const items = buildUncertaintyStripItems('agent', confidence);
    expect(items[0]?.level).toBe('guessed');
    expect(items[1]?.level).toBe('inferred');
  });

  it("only HIGH-LEVERAGE 'inferred' fields appear (low-leverage inferred excluded)", () => {
    const confidence: SpecConfidence = {
      // agent mold: name (leverage 10) inferred — should NOT appear
      name: 'inferred',
      // agent mold: capabilities (leverage 90) inferred — SHOULD appear
      capabilities: 'inferred',
    };
    const items = buildUncertaintyStripItems('agent', confidence);
    const fields = items.map((i) => i.field);
    expect(fields).toContain('capabilities');
    expect(fields).not.toContain('name');
  });

  it("'stated' fields NEVER appear in the strip", () => {
    const confidence: SpecConfidence = {
      goal: 'stated',
      entities: 'stated',
      pages: 'stated',
    };
    const items = buildUncertaintyStripItems('software', confidence);
    expect(items).toEqual([]);
  });

  it("empty / undefined confidence returns [] (no strip rendered)", () => {
    expect(buildUncertaintyStripItems('software', null)).toEqual([]);
    expect(buildUncertaintyStripItems('software', undefined)).toEqual([]);
    expect(buildUncertaintyStripItems('software', {})).toEqual([]);
  });

  it('hasUncertainties flips correctly across the same inputs', () => {
    expect(hasUncertainties('software', null)).toBe(false);
    expect(hasUncertainties('software', { goal: 'stated' })).toBe(false);
    expect(
      hasUncertainties('software', { entities: 'missing' } as SpecConfidence),
    ).toBe(true);
  });
});

// ===========================================================================
// PER-MOLD COVERAGE
// ===========================================================================
describe('per-mold strip items — each mold surfaces ITS top-level fields', () => {
  it('agent — capabilities/trigger/goal are highest leverage', () => {
    const confidence: SpecConfidence = {
      goal: 'missing',
      capabilities: 'missing',
      trigger: 'guessed',
      name: 'missing', // leverage 10 — should still appear (missing always surfaces)
    };
    const items = buildUncertaintyStripItems('agent', confidence);
    const fields = items.map((i) => i.field);
    expect(fields).toContain('capabilities');
    expect(fields).toContain('goal');
    expect(fields).toContain('trigger');
    // name is missing but leverage 10 — surfaces too (missing always surfaces),
    // just LAST in the missing bucket.
    expect(fields).toContain('name');
    // Order check: capabilities (90) before goal (90) before name (10).
    // Within the missing bucket the higher leverage wins.
    const idxCap = fields.indexOf('capabilities');
    const idxName = fields.indexOf('name');
    expect(idxCap).toBeLessThan(idxName);
  });

  it('system — sub_agents and coordination_pattern lead', () => {
    const confidence: SpecConfidence = {
      sub_agents: 'missing',
      coordination_pattern: 'missing',
      max_steps: 'guessed',
    };
    const items = buildUncertaintyStripItems('system', confidence);
    expect(items[0]?.field).toBe('sub_agents'); // leverage 100
    expect(items[1]?.field).toBe('coordination_pattern'); // leverage 95
  });

  it('software — entities lead (leverage 100)', () => {
    const confidence: SpecConfidence = {
      entities: 'missing',
      flows: 'missing',
      goal: 'missing',
    };
    const items = buildUncertaintyStripItems('software', confidence);
    expect(items[0]?.field).toBe('entities');
  });

  it('infrastructure — resources + lifecycle lead', () => {
    const confidence: SpecConfidence = {
      resources: 'missing',
      lifecycle: 'guessed',
      region: 'missing',
    };
    const items = buildUncertaintyStripItems('infrastructure', confidence);
    expect(items[0]?.field).toBe('resources'); // leverage 100, missing
    // lifecycle (95) is GUESSED — appears AFTER all missings.
    const idxLifecycle = items.findIndex((i) => i.field === 'lifecycle');
    const idxResources = items.findIndex((i) => i.field === 'resources');
    expect(idxResources).toBeLessThan(idxLifecycle);
  });
});

// ===========================================================================
// BACKWARD COMPATIBILITY — historical specs without confidence_json
// ===========================================================================
describe('backward compatibility — null/undefined confidence', () => {
  it('levelForField returns null when confidence is null/undefined', () => {
    expect(levelForField(null, 'goal')).toBeNull();
    expect(levelForField(undefined, 'goal')).toBeNull();
  });

  it('levelForField returns null for fields not present in the map', () => {
    expect(levelForField({ goal: 'stated' } as SpecConfidence, 'inputs')).toBeNull();
  });

  it("levelForField returns the level when present", () => {
    expect(
      levelForField({ goal: 'guessed' } as SpecConfidence, 'goal'),
    ).toBe('guessed');
  });

  it('null confidence → no strip items (UI renders nothing)', () => {
    expect(buildUncertaintyStripItems('agent', null)).toEqual([]);
    expect(buildUncertaintyStripItems('software', undefined)).toEqual([]);
  });
});

// ===========================================================================
// HUMANISE FIELD NAME
// ===========================================================================
describe('humaniseFieldName', () => {
  it('converts lower_snake_case to space-separated Sentence Case', () => {
    expect(humaniseFieldName('goal')).toBe('Goal');
    expect(humaniseFieldName('sub_agents')).toBe('Sub agents');
    expect(humaniseFieldName('auth_per_user_isolation')).toBe('Auth per user isolation');
  });
});

// ===========================================================================
// HERMETICITY
// ===========================================================================
describe('confidence-display hermeticity', () => {
  it('no real fetch was issued', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
