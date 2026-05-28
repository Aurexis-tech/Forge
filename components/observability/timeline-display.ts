// Pure presentation helpers for the ForgeTimelinePanel. Same
// node-friendly pattern as components/spec/confidence-display.ts —
// the helpers are deterministic functions over the assembled
// timeline, and the React component is a thin JSX wrapper. Tests
// cover the helpers (real DOM env not available); the component
// follows by construction.

import type {
  ForgeTimeline,
  ForgeTimelineEvent,
  ForgeTimelinePhase,
  ForgeTimelinePhaseCosts,
} from '@/lib/engine/observability/timeline';
import type { ErrorCategory } from '@/lib/engine/errors';

// ---------------------------------------------------------------------------
// LEVEL → TONE
// ---------------------------------------------------------------------------
export const LEVEL_TONE: Record<
  ForgeTimelineEvent['level'],
  {
    /** Tailwind className for the level badge background + border + text. */
    readonly badge: string;
    /** Tailwind className for the row's left-edge accent. */
    readonly rowBorder: string;
    /** Single-glyph icon shown in the badge. */
    readonly glyph: string;
    /** Short uppercase label. */
    readonly label: string;
  }
> = {
  info: {
    badge: 'border-forge-cyan/30 bg-forge-cyan/[0.08] text-forge-cyan',
    rowBorder: 'border-l border-white/5',
    glyph: '·',
    label: 'info',
  },
  warn: {
    badge: 'border-forge-amber/40 bg-forge-amber/[0.10] text-forge-amber',
    rowBorder: 'border-l border-forge-amber/40',
    glyph: '!',
    label: 'warn',
  },
  error: {
    badge: 'border-rose-400/50 bg-rose-500/[0.08] text-rose-300',
    rowBorder: 'border-l border-rose-400/50',
    glyph: '×',
    label: 'error',
  },
};

// ---------------------------------------------------------------------------
// CATEGORY GLYPH — single character that hints at the engine error
// category for the timeline row badge. Used only when a category is
// present (i.e. the audit row carried engine_error_category).
// ---------------------------------------------------------------------------
export const CATEGORY_GLYPH: Record<ErrorCategory, string> = {
  governance: '⛔',
  auth: '🔒',
  bad_input: '✎',
  not_found: '?',
  permission: '🚫',
  transient_provider: '↻',
  permanent_provider: '!',
  internal: '⚠',
};

// ---------------------------------------------------------------------------
// RELATIVE TIME
//
// "12s ago", "2m ago", "3h ago", "5d ago", "2026-04-15". Pure: takes
// `nowMs` so tests can pass a fixed reference time.
// ---------------------------------------------------------------------------
export function formatRelativeTime(
  timestamp: string,
  nowMs: number = Date.now(),
): string {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return timestamp;
  const deltaMs = Math.max(0, nowMs - t);
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  // Older than a month — show the date.
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// PHASE CHIP — format a phase cost as "<phase> $X.XX".
// ---------------------------------------------------------------------------
export function formatPhaseChip(
  phase: ForgeTimelinePhase,
  amount: number,
): string {
  const tag = phase.replace(/_/g, ' ');
  return tag + ' $' + amount.toFixed(2);
}

/**
 * Order phases highest-cost-first, but always keep `total` (when
 * present in the returned array) last. Used by the panel header
 * to render the chip row.
 */
export function orderedPhaseChips(
  costs: ForgeTimelinePhaseCosts,
): Array<{ phase: ForgeTimelinePhase; amount: number }> {
  const entries = Object.entries(costs) as Array<
    [ForgeTimelinePhase, number]
  >;
  const filtered = entries.filter(([, v]) => v > 0);
  filtered.sort((a, b) => b[1] - a[1]);
  return filtered.map(([phase, amount]) => ({ phase, amount }));
}

export function formatTotalCost(totalUsd: number): string {
  return '$' + totalUsd.toFixed(2);
}

// ---------------------------------------------------------------------------
// EVENT MESSAGE RESOLUTION
//
// For error events that carry `engine_error_user_message` in their
// details, surface the SAFE userMessage instead of the raw engine
// message. Otherwise fall through to event.message (assembled by
// the timeline). This is what makes the panel say "The Forge is
// paused" rather than "Error: undefined".
// ---------------------------------------------------------------------------
export function resolveEventMessage(event: ForgeTimelineEvent): string {
  if (event.level === 'error' || event.category !== null) {
    const um = event.details.engine_error_user_message;
    if (typeof um === 'string' && um.length > 0) {
      return um;
    }
  }
  return event.message;
}

// ---------------------------------------------------------------------------
// LIVE-TAIL POLLING DECISION
//
// Pure boolean: should the panel poll? True when:
//   - the panel is EXPANDED, AND
//   - the project has an in-progress build (one of the statuses
//     below).
// When collapsed, polling NEVER fires — no idle work for users
// who aren't looking.
// ---------------------------------------------------------------------------
export const IN_PROGRESS_BUILD_STATUSES: ReadonlySet<string> = new Set([
  'generating',
  'testing',
  'pushing',
  'deploying',
  'applying',
  'planning',
  'previewing',
  'provisioning',
]);

export interface ShouldPollArgs {
  expanded: boolean;
  /** Latest build status for the project, if any. */
  buildStatus: string | null | undefined;
}

export function shouldPoll(args: ShouldPollArgs): boolean {
  if (!args.expanded) return false;
  if (!args.buildStatus) return false;
  return IN_PROGRESS_BUILD_STATUSES.has(args.buildStatus);
}

// ---------------------------------------------------------------------------
// TIMELINE TRUNCATION COPY
// ---------------------------------------------------------------------------
export function truncationLabel(timeline: ForgeTimeline): string | null {
  if (!timeline.truncated) return null;
  return 'showing latest ' + timeline.events.length + ' events';
}

// Re-export the level + event types so consumers have one import.
export type { ForgeTimeline, ForgeTimelineEvent, ForgeTimelinePhase, ForgeTimelinePhaseCosts };
