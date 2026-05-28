// FORGE TIMELINE PANEL — server component.
//
// Reads the assembled timeline directly via the project page's
// existing Supabase server client + renders it. Collapsed by
// default; the disclosure header carries the total cost as a teaser
// + the truncation indicator. The collapsed/expanded state lives in
// a small client wrapper (LiveTailWrapper) which ALSO drives the
// 5-second polling cadence when the panel is expanded AND a build
// is in progress.
//
// 2D markup only — no WebGL, no R3F. Brand tokens: forge-amber,
// forge-cyan, rose-* (Tailwind stock for error-tone).

import type {
  ForgeTimeline,
  ForgeTimelineEvent,
} from '@/lib/engine/observability/timeline';
import {
  CATEGORY_GLYPH,
  formatPhaseChip,
  formatRelativeTime,
  formatTotalCost,
  LEVEL_TONE,
  orderedPhaseChips,
  resolveEventMessage,
  truncationLabel,
} from './timeline-display';
import { LiveTailWrapper } from './LiveTailWrapper';

export interface ForgeTimelinePanelProps {
  /** The assembled timeline produced server-side. */
  timeline: ForgeTimeline;
  /**
   * Build status the live-tail polling cadence reads. Pass the
   * latest project build's `status`. `null` disables polling
   * regardless of the expanded state.
   */
  buildStatus: string | null;
}

export function ForgeTimelinePanel({
  timeline,
  buildStatus,
}: ForgeTimelinePanelProps) {
  const chips = orderedPhaseChips(timeline.phaseCosts);
  const totalCost = formatTotalCost(timeline.totalCostUsd);
  const truncated = truncationLabel(timeline);

  return (
    <LiveTailWrapper buildStatus={buildStatus}>
      <section
        data-testid="forge-timeline-panel"
        className="rounded-2xl border border-white/10 bg-forge-panel p-5 shadow-glass backdrop-blur-md"
      >
        <details className="group" data-testid="forge-timeline-disclosure">
          <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              forge timeline · {timeline.events.length} events
            </h3>
            <p className="font-mono text-xs text-forge-text">
              total {totalCost}
              <span className="ml-2 text-forge-dim">↓ expand</span>
            </p>
          </summary>

          {/* Header: phase-cost chips. */}
          <header className="mt-4 flex flex-wrap items-center gap-1.5">
            {chips.length === 0 ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                no spend yet
              </span>
            ) : (
              chips.map(({ phase, amount }) => (
                <span
                  key={phase}
                  data-testid="phase-chip"
                  className="rounded-full border border-forge-amber/30 bg-forge-amber/[0.06] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-forge-amber"
                >
                  {formatPhaseChip(phase, amount)}
                </span>
              ))
            )}
          </header>

          {/* Body: events list. */}
          <div className="mt-4">
            {timeline.events.length === 0 ? (
              <p
                data-testid="timeline-empty"
                className="rounded-lg border border-white/5 bg-black/30 px-3 py-4 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-forge-dim"
              >
                no events yet
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {timeline.events.map((event) => (
                  <TimelineRow
                    key={event.kind + ':' + event.id}
                    event={event}
                  />
                ))}
              </ul>
            )}

            {truncated ? (
              <p
                data-testid="timeline-truncation"
                className="mt-3 text-right font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim"
              >
                {truncated}
              </p>
            ) : null}
          </div>
        </details>
      </section>
    </LiveTailWrapper>
  );
}

// ---------------------------------------------------------------------------
// One row per event.
// ---------------------------------------------------------------------------
function TimelineRow({ event }: { event: ForgeTimelineEvent }) {
  const tone = LEVEL_TONE[event.level];
  const message = resolveEventMessage(event);
  return (
    <li
      data-testid="timeline-row"
      data-level={event.level}
      data-kind={event.kind}
      className={
        'flex flex-wrap items-baseline gap-2 rounded-lg bg-black/30 px-3 py-2 pl-3 ' +
        tone.rowBorder
      }
    >
      <span
        data-testid="timeline-time"
        className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim"
        title={event.timestamp}
      >
        {formatRelativeTime(event.timestamp)}
      </span>
      <span
        data-testid="timeline-badge"
        className={
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] ' +
          tone.badge
        }
      >
        <span aria-hidden="true">{tone.glyph}</span>
        <span>{tone.label}</span>
        {event.category ? (
          <span
            aria-hidden="true"
            title={event.category}
            className="ml-1"
          >
            {CATEGORY_GLYPH[event.category]}
          </span>
        ) : null}
      </span>
      <span className="flex-1 text-sm text-forge-text/90">{message}</span>
      {typeof event.cost_usd === 'number' ? (
        <span className="font-mono text-xs text-forge-amber">
          ${event.cost_usd.toFixed(4)}
        </span>
      ) : null}
      {event.ref ? (
        <span
          data-testid="timeline-ref"
          className="font-mono text-[10px] text-forge-dim"
          title={event.ref}
        >
          {event.ref}
        </span>
      ) : null}
    </li>
  );
}
