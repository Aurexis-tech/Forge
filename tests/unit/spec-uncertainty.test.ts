// Hermetic unit test — UNCERTAINTY detector + leverage + question
// selector. Pure functions: deterministic, no network, no LLM.

import { describe, expect, it } from 'vitest';
import {
  detectUncertainty,
  LEVERAGE_THRESHOLD,
  selectClarification,
} from '@/lib/engine/spec/uncertainty';
import type { SpecConfidence } from '@/lib/engine/spec/confidence';

describe('detectUncertainty — software', () => {
  it("returns one entry per non-'stated' field above (or any 'missing' / 'guessed')", () => {
    const confidence: SpecConfidence = {
      goal: 'stated',
      pages: 'inferred',
      entities: 'missing',
      flows: 'missing',
      auth_requires_auth: 'guessed',
      auth_per_user_isolation: 'stated',
    };
    const report = detectUncertainty({
      mold: 'software',
      spec: {},
      confidence,
      intent: '',
    });
    // entities (100) + pages (90 inferred) + flows (60 missing) +
    // auth_requires_auth (80 guessed). Goal stated → excluded.
    // auth_per_user_isolation stated → excluded.
    const fields = report.entries.map((e) => e.field);
    expect(fields).toContain('entities');
    expect(fields).toContain('pages');
    expect(fields).toContain('flows');
    expect(fields).toContain('auth_requires_auth');
    expect(fields).not.toContain('goal');
    expect(fields).not.toContain('auth_per_user_isolation');
  });

  it('sorts entries by leverage DESC (highest first)', () => {
    const confidence: SpecConfidence = {
      goal: 'missing',
      pages: 'missing',
      entities: 'missing',
      flows: 'missing',
      auth_requires_auth: 'missing',
      auth_per_user_isolation: 'missing',
    };
    const report = detectUncertainty({
      mold: 'software',
      spec: {},
      confidence,
      intent: '',
    });
    // entities (100) > pages (90) > auth_per_user_isolation (90) >
    // auth_requires_auth (80) > flows (60) > goal (50).
    const sorted = [...report.entries].sort((a, b) => b.leverage - a.leverage);
    expect(report.entries).toEqual(sorted);
    expect(report.entries[0]?.field).toBe('entities');
  });

  it("ties broken consistently: 'missing' before 'guessed' before 'inferred', then field name", () => {
    const confidence: SpecConfidence = {
      // pages + auth_per_user_isolation both have leverage 90.
      pages: 'inferred',
      auth_per_user_isolation: 'missing',
    };
    const report = detectUncertainty({
      mold: 'software',
      spec: {},
      confidence,
      intent: '',
    });
    expect(report.entries[0]?.field).toBe('auth_per_user_isolation');
    expect(report.entries[1]?.field).toBe('pages');
  });

  it('hasActionable=true when any entry meets the threshold', () => {
    const confidence: SpecConfidence = {
      goal: 'missing', // leverage 50 — below threshold
      entities: 'missing', // leverage 100 — above threshold
    };
    const report = detectUncertainty({
      mold: 'software',
      spec: {},
      confidence,
      intent: '',
    });
    expect(report.hasActionable).toBe(true);
  });

  it('hasActionable=false when nothing clears the threshold', () => {
    const confidence: SpecConfidence = {
      goal: 'missing', // leverage 50 — below threshold
    };
    const report = detectUncertainty({
      mold: 'software',
      spec: {},
      confidence,
      intent: '',
    });
    expect(report.hasActionable).toBe(false);
    expect(LEVERAGE_THRESHOLD).toBeGreaterThan(50);
  });
});

describe('detectUncertainty — agent', () => {
  it("'capabilities:missing' is high leverage (>=70)", () => {
    const report = detectUncertainty({
      mold: 'agent',
      spec: {},
      confidence: { capabilities: 'missing' } as SpecConfidence,
      intent: '',
    });
    expect(report.entries[0]?.field).toBe('capabilities');
    expect(report.entries[0]?.leverage).toBeGreaterThanOrEqual(LEVERAGE_THRESHOLD);
  });

  it("'name:guessed' is low leverage (under threshold)", () => {
    const report = detectUncertainty({
      mold: 'agent',
      spec: {},
      confidence: { name: 'guessed' } as SpecConfidence,
      intent: '',
    });
    // The entry IS in the report (guessed always surfaces) but
    // below the actionable threshold.
    expect(report.entries[0]?.field).toBe('name');
    expect(report.entries[0]?.leverage).toBeLessThan(LEVERAGE_THRESHOLD);
    expect(report.hasActionable).toBe(false);
  });

  it("'inferred' low-leverage fields are filtered out entirely", () => {
    const report = detectUncertainty({
      mold: 'agent',
      spec: {},
      confidence: { name: 'inferred', risk: 'inferred' } as SpecConfidence,
      intent: '',
    });
    expect(report.entries).toEqual([]);
  });
});

describe('detectUncertainty — system', () => {
  it("'sub_agents:missing' is leverage 100 (the highest)", () => {
    const report = detectUncertainty({
      mold: 'system',
      spec: {},
      confidence: {
        sub_agents: 'missing',
        coordination_pattern: 'missing',
      } as SpecConfidence,
      intent: '',
    });
    expect(report.entries[0]?.field).toBe('sub_agents');
    expect(report.entries[0]?.leverage).toBe(100);
  });
});

describe('selectClarification — picks the highest-leverage uncertainty', () => {
  it("returns the top entry + a question template for (mold, field, level)", () => {
    const report = detectUncertainty({
      mold: 'software',
      spec: {},
      confidence: { entities: 'missing' } as SpecConfidence,
      intent: '',
    });
    const sel = selectClarification(report);
    expect(sel).not.toBeNull();
    expect(sel!.entry.field).toBe('entities');
    // Question should be the hand-authored template — concrete,
    // not generic.
    expect(sel!.question.toLowerCase()).toMatch(/data model|track|amount|expense/);
  });

  it('returns null when nothing actionable', () => {
    const report = detectUncertainty({
      mold: 'agent',
      spec: {},
      confidence: { risk: 'inferred' } as SpecConfidence, // leverage 20
      intent: '',
    });
    expect(selectClarification(report)).toBeNull();
  });

  it("uses a (field, level)-specific question for 'guessed' vs 'missing'", () => {
    const reportMissing = detectUncertainty({
      mold: 'software',
      spec: {},
      confidence: { auth_per_user_isolation: 'missing' } as SpecConfidence,
      intent: '',
    });
    const reportGuessed = detectUncertainty({
      mold: 'software',
      spec: {},
      confidence: { auth_per_user_isolation: 'guessed' } as SpecConfidence,
      intent: '',
    });
    const qMissing = selectClarification(reportMissing)?.question ?? '';
    const qGuessed = selectClarification(reportGuessed)?.question ?? '';
    expect(qMissing).not.toEqual(qGuessed);
    expect(qMissing).toMatch(/Should each user/);
    expect(qGuessed).toMatch(/I assumed/);
  });
});
