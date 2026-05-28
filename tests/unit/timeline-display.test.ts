// Hermetic render tests for the ForgeTimelinePanel's presentation
// layer.
//
// The project ships without a DOM test env (vitest + node). So
// rather than render the React component into a virtual DOM, these
// tests cover the PURE HELPERS that the component consumes:
//
//   - LEVEL_TONE — per-level tone matrix (info/warn/error) →
//     badge classes, row-border classes, glyph, label. The
//     ForgeTimelinePanel uses these verbatim, so any regression
//     here is a regression in the visible UI.
//   - CATEGORY_GLYPH — one glyph per EngineError category.
//   - formatRelativeTime — deterministic relative-time formatting.
//   - formatPhaseChip / orderedPhaseChips / formatTotalCost —
//     header chip rendering.
//   - resolveEventMessage — error events surface the SAFE
//     userMessage; non-error events fall through to event.message.
//   - shouldPoll / IN_PROGRESS_BUILD_STATUSES — live-tail polling
//     gate. Polling MUST be off when collapsed; polling MUST be
//     off when buildStatus is terminal/idle.
//   - truncationLabel — empty/full-page indicator copy.
//
// The ForgeTimelinePanel component is a thin JSX wrapper over
// these helpers; once the helpers produce the right shapes, the
// component does the right thing by construction.

import { describe, expect, it } from 'vitest';
import {
  CATEGORY_GLYPH,
  formatPhaseChip,
  formatRelativeTime,
  formatTotalCost,
  IN_PROGRESS_BUILD_STATUSES,
  LEVEL_TONE,
  orderedPhaseChips,
  resolveEventMessage,
  shouldPoll,
  truncationLabel,
} from '@/components/observability/timeline-display';
import type {
  ForgeTimeline,
  ForgeTimelineEvent,
  ForgeTimelinePhaseCosts,
} from '@/lib/engine/observability/timeline';
import { ERROR_CATEGORIES } from '@/lib/engine/errors';

// ---------------------------------------------------------------------------
// Test fixture helpers.
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<ForgeTimelineEvent> = {},
): ForgeTimelineEvent {
  return {
    id: 'evt-1',
    timestamp: '2026-01-01T12:00:00.000Z',
    kind: 'audit',
    category: null,
    level: 'info',
    message: 'something happened',
    ref: null,
    cost_usd: null,
    details: {},
    ...overrides,
  };
}

function makePhaseCosts(
  partial: Partial<ForgeTimelinePhaseCosts> = {},
): ForgeTimelinePhaseCosts {
  return {
    codegen: 0,
    critique: 0,
    refine: 0,
    sandbox: 0,
    runtime: 0,
    spec_extract: 0,
    clarification: 0,
    judge: 0,
    other: 0,
    ...partial,
  };
}

function makeTimeline(
  events: ForgeTimelineEvent[],
  opts: { truncated?: boolean; phaseCosts?: ForgeTimelinePhaseCosts; totalCostUsd?: number } = {},
): ForgeTimeline {
  return {
    events,
    phaseCosts: opts.phaseCosts ?? makePhaseCosts(),
    totalCostUsd: opts.totalCostUsd ?? 0,
    truncated: opts.truncated ?? false,
  };
}

// ===========================================================================
// LEVEL_TONE matrix — info / warn / error each have distinct visual
// weight. Any regression here changes how the panel reads at a glance.
// ===========================================================================
describe('LEVEL_TONE — per-level visual weight', () => {
  it("'info' uses subtle cyan tones with the lightest row border", () => {
    const t = LEVEL_TONE.info;
    expect(t.label).toBe('info');
    expect(t.badge).toMatch(/text-forge-cyan/);
    expect(t.badge).toMatch(/border-forge-cyan/);
    // No rose anywhere — info is not an error.
    expect(t.badge).not.toMatch(/rose/);
    expect(t.rowBorder).not.toMatch(/rose/);
    expect(t.rowBorder).not.toMatch(/forge-amber/);
  });

  it("'warn' uses amber tones with an amber row accent", () => {
    const t = LEVEL_TONE.warn;
    expect(t.label).toBe('warn');
    expect(t.badge).toMatch(/text-forge-amber/);
    expect(t.badge).toMatch(/border-forge-amber/);
    expect(t.rowBorder).toMatch(/forge-amber/);
    expect(t.rowBorder).not.toMatch(/rose/);
  });

  it("'error' uses rose tones with a ROSE row accent — distinct from info/warn", () => {
    const t = LEVEL_TONE.error;
    expect(t.label).toBe('error');
    expect(t.badge).toMatch(/rose/);
    // The row border MUST carry the rose tint — this is what
    // creates the visible "error highlight" lane on the timeline.
    expect(t.rowBorder).toMatch(/rose/);
  });

  it('each level has a distinct single-character glyph', () => {
    const glyphs = new Set([
      LEVEL_TONE.info.glyph,
      LEVEL_TONE.warn.glyph,
      LEVEL_TONE.error.glyph,
    ]);
    expect(glyphs.size).toBe(3);
    for (const g of glyphs) {
      expect(g.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// CATEGORY_GLYPH — one glyph per ErrorCategory.
// ===========================================================================
describe('CATEGORY_GLYPH — covers every ErrorCategory', () => {
  it('has a glyph for every ERROR_CATEGORIES entry', () => {
    for (const cat of ERROR_CATEGORIES) {
      const g = CATEGORY_GLYPH[cat];
      expect(typeof g).toBe('string');
      expect(g.length).toBeGreaterThan(0);
    }
  });

  it('governance + auth + permission have visually distinct glyphs from transient_provider', () => {
    expect(CATEGORY_GLYPH.governance).not.toBe(CATEGORY_GLYPH.transient_provider);
    expect(CATEGORY_GLYPH.auth).not.toBe(CATEGORY_GLYPH.transient_provider);
    expect(CATEGORY_GLYPH.permission).not.toBe(CATEGORY_GLYPH.transient_provider);
  });
});

// ===========================================================================
// RELATIVE TIME — deterministic against a fixed nowMs.
// ===========================================================================
describe('formatRelativeTime', () => {
  const NOW = Date.parse('2026-01-01T12:00:00.000Z');

  it("'just now' (<60s) reads as 'Ns ago'", () => {
    expect(formatRelativeTime('2026-01-01T11:59:45.000Z', NOW)).toBe('15s ago');
    expect(formatRelativeTime('2026-01-01T12:00:00.000Z', NOW)).toBe('0s ago');
  });

  it('seconds round down to whole minutes/hours/days', () => {
    expect(formatRelativeTime('2026-01-01T11:58:00.000Z', NOW)).toBe('2m ago');
    expect(formatRelativeTime('2026-01-01T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(formatRelativeTime('2025-12-30T12:00:00.000Z', NOW)).toBe('2d ago');
  });

  it('events older than 30 days show the date (YYYY-MM-DD)', () => {
    expect(formatRelativeTime('2025-09-01T12:00:00.000Z', NOW)).toBe('2025-09-01');
  });

  it('rejects timestamps in the future as 0s ago (no negative deltas)', () => {
    expect(formatRelativeTime('2026-01-02T12:00:00.000Z', NOW)).toBe('0s ago');
  });

  it('returns the raw string when the timestamp is unparseable', () => {
    expect(formatRelativeTime('not a date', NOW)).toBe('not a date');
  });
});

// ===========================================================================
// PHASE CHIPS — header roll-up.
// ===========================================================================
describe('formatPhaseChip + orderedPhaseChips + formatTotalCost', () => {
  it('formats a chip as "<phase> $X.XX" with underscores stripped', () => {
    expect(formatPhaseChip('codegen', 1.2345)).toBe('codegen $1.23');
    expect(formatPhaseChip('spec_extract', 0.5)).toBe('spec extract $0.50');
  });

  it('orderedPhaseChips returns only nonzero phases, sorted highest-first', () => {
    const costs = makePhaseCosts({
      codegen: 0.5,
      critique: 2.0,
      sandbox: 0.1,
      runtime: 0, // filtered
    });
    const chips = orderedPhaseChips(costs);
    expect(chips.map((c) => c.phase)).toEqual(['critique', 'codegen', 'sandbox']);
    expect(chips.map((c) => c.amount)).toEqual([2.0, 0.5, 0.1]);
  });

  it('orderedPhaseChips returns [] when nothing has been spent', () => {
    expect(orderedPhaseChips(makePhaseCosts())).toEqual([]);
  });

  it("formatTotalCost always shows two decimals with a '$' prefix", () => {
    expect(formatTotalCost(0)).toBe('$0.00');
    expect(formatTotalCost(1.2345)).toBe('$1.23');
    expect(formatTotalCost(1234.5)).toBe('$1234.50');
  });
});

// ===========================================================================
// EVENT MESSAGE RESOLUTION — error events surface the SAFE user
// message; non-error events fall through to event.message.
// ===========================================================================
describe('resolveEventMessage', () => {
  it('error events surface engine_error_user_message when present', () => {
    const ev = makeEvent({
      level: 'error',
      category: 'transient_provider',
      message: 'raw: ECONNRESET at hostname:443',
      details: {
        engine_error_user_message: 'The provider is temporarily unavailable.',
      },
    });
    expect(resolveEventMessage(ev)).toBe(
      'The provider is temporarily unavailable.',
    );
  });

  it('error events fall back to event.message when no userMessage is recorded', () => {
    const ev = makeEvent({
      level: 'error',
      category: 'internal',
      message: 'codegen.run_failed',
      details: {},
    });
    expect(resolveEventMessage(ev)).toBe('codegen.run_failed');
  });

  it('info events with a category still prefer the userMessage (governance audits)', () => {
    const ev = makeEvent({
      level: 'info',
      category: 'governance',
      message: 'governance.guard_failed',
      details: {
        engine_error_user_message: 'The Forge is paused — budget exhausted.',
      },
    });
    expect(resolveEventMessage(ev)).toBe(
      'The Forge is paused — budget exhausted.',
    );
  });

  it('info events without a category use the raw event.message', () => {
    const ev = makeEvent({
      level: 'info',
      category: null,
      message: 'spec extracted',
      details: { engine_error_user_message: 'ignored' },
    });
    expect(resolveEventMessage(ev)).toBe('spec extracted');
  });

  it('rejects empty string userMessage and falls through', () => {
    const ev = makeEvent({
      level: 'error',
      category: 'internal',
      message: 'fallback works',
      details: { engine_error_user_message: '' },
    });
    expect(resolveEventMessage(ev)).toBe('fallback works');
  });
});

// ===========================================================================
// LIVE-TAIL POLLING GATE — shouldPoll must be conservative:
// collapsed = no poll, idle = no poll. Anything else MUST poll.
// ===========================================================================
describe('shouldPoll — live-tail gate', () => {
  it('collapsed panel NEVER polls, regardless of buildStatus', () => {
    for (const status of [
      'generating',
      'testing',
      'pushing',
      'deploying',
      'applying',
      'idle',
      null,
    ]) {
      expect(shouldPoll({ expanded: false, buildStatus: status })).toBe(false);
    }
  });

  it('expanded + null buildStatus does NOT poll (no in-flight build)', () => {
    expect(shouldPoll({ expanded: true, buildStatus: null })).toBe(false);
    expect(shouldPoll({ expanded: true, buildStatus: undefined })).toBe(false);
  });

  it('expanded + terminal buildStatus does NOT poll', () => {
    for (const status of [
      'generated',
      'tested',
      'pushed',
      'deployed',
      'failed',
      'test_failed',
      'deploy_failed',
      'running', // runtime-on is steady state, not "in progress"
    ]) {
      expect(shouldPoll({ expanded: true, buildStatus: status })).toBe(false);
    }
  });

  it('expanded + every IN_PROGRESS_BUILD_STATUSES entry polls', () => {
    for (const status of IN_PROGRESS_BUILD_STATUSES) {
      expect(shouldPoll({ expanded: true, buildStatus: status })).toBe(true);
    }
  });

  it('IN_PROGRESS_BUILD_STATUSES covers every multi-phase build lane', () => {
    // Defence-in-depth: the live-tail gate is the only client-side
    // refresh trigger. If a new "in-flight" status is added to the
    // engine without this set being updated, the panel stops being
    // live-tail. Lock the membership.
    expect(IN_PROGRESS_BUILD_STATUSES.has('generating')).toBe(true);
    expect(IN_PROGRESS_BUILD_STATUSES.has('testing')).toBe(true);
    expect(IN_PROGRESS_BUILD_STATUSES.has('pushing')).toBe(true);
    expect(IN_PROGRESS_BUILD_STATUSES.has('deploying')).toBe(true);
    expect(IN_PROGRESS_BUILD_STATUSES.has('applying')).toBe(true);
    expect(IN_PROGRESS_BUILD_STATUSES.has('planning')).toBe(true);
    expect(IN_PROGRESS_BUILD_STATUSES.has('previewing')).toBe(true);
    expect(IN_PROGRESS_BUILD_STATUSES.has('provisioning')).toBe(true);
  });
});

// ===========================================================================
// TRUNCATION LABEL — the "showing latest N events" tail indicator.
// ===========================================================================
describe('truncationLabel', () => {
  it('returns null when the timeline was not truncated', () => {
    const tl = makeTimeline([makeEvent({ id: 'a' })], { truncated: false });
    expect(truncationLabel(tl)).toBeNull();
  });

  it('reports the visible event count when truncated', () => {
    const tl = makeTimeline(
      Array.from({ length: 200 }, (_, i) => makeEvent({ id: 'e' + i })),
      { truncated: true },
    );
    expect(truncationLabel(tl)).toBe('showing latest 200 events');
  });

  it('handles the truncated-but-empty edge case', () => {
    const tl = makeTimeline([], { truncated: true });
    expect(truncationLabel(tl)).toBe('showing latest 0 events');
  });
});

// ===========================================================================
// COMPOSITE — A representative mixed timeline must produce the
// shapes the panel renders downstream (header chips + ordered events
// + error highlighting + truncation indicator).
// ===========================================================================
describe('mixed-event timeline → panel shape', () => {
  it('a representative timeline produces ordered chips + safe error message + truncation', () => {
    const NOW = Date.parse('2026-01-01T12:00:00.000Z');
    const tl = makeTimeline(
      [
        makeEvent({
          id: 'info-1',
          level: 'info',
          message: 'spec extracted',
          timestamp: '2026-01-01T11:59:30.000Z',
        }),
        makeEvent({
          id: 'warn-1',
          level: 'warn',
          category: 'transient_provider',
          message: 'codegen retry 2',
          timestamp: '2026-01-01T11:58:00.000Z',
        }),
        makeEvent({
          id: 'err-1',
          level: 'error',
          category: 'governance',
          message: 'governance.guard_failed',
          details: {
            engine_error_user_message:
              'The Forge is paused — budget exhausted.',
          },
          timestamp: '2026-01-01T11:55:00.000Z',
        }),
      ],
      {
        truncated: true,
        phaseCosts: makePhaseCosts({
          codegen: 0.5,
          critique: 2.0,
          sandbox: 0.1,
        }),
        totalCostUsd: 2.6,
      },
    );

    // Header chips — highest-cost-first.
    const chips = orderedPhaseChips(tl.phaseCosts);
    expect(chips.map((c) => c.phase)).toEqual([
      'critique',
      'codegen',
      'sandbox',
    ]);

    // Total cost teaser.
    expect(formatTotalCost(tl.totalCostUsd)).toBe('$2.60');

    // Error row — surfaces userMessage, not raw audit action.
    const errRow = tl.events.find((e) => e.level === 'error')!;
    expect(resolveEventMessage(errRow)).toBe(
      'The Forge is paused — budget exhausted.',
    );

    // Relative-time of the most recent event.
    const firstRow = tl.events[0]!;
    expect(formatRelativeTime(firstRow.timestamp, NOW)).toBe('30s ago');

    // Truncation indicator visible.
    expect(truncationLabel(tl)).toBe('showing latest 3 events');
  });

  it('an EMPTY timeline still produces the no-spend + truncation-null shape the panel uses', () => {
    const tl = makeTimeline([]);
    expect(orderedPhaseChips(tl.phaseCosts)).toEqual([]);
    expect(formatTotalCost(tl.totalCostUsd)).toBe('$0.00');
    expect(truncationLabel(tl)).toBeNull();
  });
});
