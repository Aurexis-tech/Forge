// 2D stepper. Rendered:
//  - inline below the 3D pipeline (`horizontal` layout, with descriptions)
//  - as the WebGL-off fallback or detail-page sidebar (`vertical` layout)
//  - as a tiny one-line glance on project list cards (`compact` layout)
//
// Same Journey, same statuses — only layout varies.

import { Fragment } from 'react';
import type { Journey, JourneyStage, JourneyStageStatus } from '@/lib/journey';

interface Props {
  journey: Journey;
  layout?: 'horizontal' | 'vertical' | 'compact';
}

// Short status word shown under each stage's title on the detail page.
// The body of the stage (raw intent / spec / plan / etc) is rendered in
// the panel BELOW the stepper, so the stepper itself stays status-only.
const STATUS_WORD: Record<JourneyStageStatus, string> = {
  done: 'Done',
  current: 'In progress',
  pending: 'Pending',
  failed: 'Failed',
  skipped: 'Skipped',
  blocked: 'Waiting',
};

const STATUS_TONE: Record<
  JourneyStageStatus,
  { dot: string; label: string; ring: string }
> = {
  done: {
    dot: 'bg-forge-amber shadow-amber',
    label: 'text-forge-text',
    ring: 'border-forge-amber/40',
  },
  current: {
    dot: 'bg-forge-cyan shadow-cyan animate-pulse',
    label: 'text-forge-cyan',
    ring: 'border-forge-cyan/60',
  },
  pending: {
    dot: 'bg-forge-dim/60',
    label: 'text-forge-dim',
    ring: 'border-white/10',
  },
  failed: {
    dot: 'bg-rose-400',
    label: 'text-rose-300',
    ring: 'border-rose-400/50',
  },
  skipped: {
    dot: 'bg-forge-amber/30',
    label: 'text-forge-dim',
    ring: 'border-forge-amber/20',
  },
  blocked: {
    dot: 'bg-amber-300/40',
    label: 'text-forge-dim',
    ring: 'border-amber-300/20',
  },
};

// --- compact ---------------------------------------------------------------
//
// Single-row glance for project-list cards. Eight dots joined by thin
// connector lines. The CURRENT stage shows its label inline; other labels
// only appear at lg+ viewports where the card has room. The row never
// overflows — connectors are flex-1 with min-widths small enough that
// they compress before the dots do. No horizontal scrollbar anywhere.

const COMPACT_DOT: Record<JourneyStageStatus, string> = {
  done: 'bg-forge-amber shadow-amber',
  current:
    // Cyan dot with a subtle ring + pulse so the eye finds it instantly.
    'bg-forge-cyan shadow-cyan ring-2 ring-forge-cyan/40 animate-pulse',
  pending: 'bg-forge-dim/40',
  failed: 'bg-rose-400',
  // Ghosted ring with no fill so skipped stages read as "not for this agent".
  skipped: 'bg-transparent ring-1 ring-forge-amber/25',
  blocked: 'bg-amber-300/30',
};

const COMPACT_CONNECTOR: Record<JourneyStageStatus, string> = {
  done: 'bg-forge-amber/70',
  current: 'bg-forge-cyan/40',
  pending: 'bg-white/10',
  failed: 'bg-rose-400/40',
  skipped: 'bg-forge-amber/15',
  blocked: 'bg-amber-300/15',
};

const COMPACT_LABEL: Record<JourneyStageStatus, string> = {
  done: 'text-forge-text/80',
  current: 'text-forge-cyan',
  pending: 'text-forge-dim',
  failed: 'text-rose-300',
  skipped: 'text-forge-dim/70',
  blocked: 'text-forge-dim',
};

// --- entry -----------------------------------------------------------------

export function JourneyStepper({ journey, layout = 'horizontal' }: Props) {
  if (layout === 'compact') {
    return <CompactRow journey={journey} />;
  }
  if (layout === 'vertical') {
    return (
      <ol className="flex flex-col gap-3">
        {journey.stages.map((stage, i) => (
          <VerticalRow
            key={stage.id}
            stage={stage}
            isLast={i === journey.stages.length - 1}
          />
        ))}
      </ol>
    );
  }

  // Uniform 8-cell grid: 2 cols on phones, 4 on small, 8 on large. Every
  // card is the same width inside its row, every card has the same height,
  // every card overflow-hides any text — so nothing can bleed into a
  // neighbour regardless of content.
  return (
    <ol className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      {journey.stages.map((stage) => (
        <HorizontalNode key={stage.id} stage={stage} />
      ))}
    </ol>
  );
}

// --- compact row -----------------------------------------------------------

function CompactRow({ journey }: { journey: Journey }) {
  return (
    <ol className="flex w-full min-w-0 items-center gap-1">
      {journey.stages.map((stage, i) => {
        const isCurrent = stage.id === journey.cursor.id;
        const tone = COMPACT_LABEL[stage.status];
        return (
          <Fragment key={stage.id}>
            <li className="flex shrink-0 items-center gap-1.5">
              <span
                aria-hidden
                className={
                  'inline-block h-2 w-2 shrink-0 rounded-full ' +
                  COMPACT_DOT[stage.status]
                }
              />
              <span
                className={
                  'font-mono text-[9px] uppercase tracking-[0.2em] ' +
                  tone +
                  // Current label is always inline. Other labels only appear
                  // once the container has plenty of room (lg+ viewport
                  // ≈ wide single-column layout). At every smaller size,
                  // we show dots only — never overflow.
                  (isCurrent ? ' inline' : ' hidden lg:inline')
                }
              >
                {stage.label.toUpperCase()}
              </span>
              <span className="sr-only">
                {stage.label} stage status: {stage.status}
              </span>
            </li>
            {i < journey.stages.length - 1 ? (
              <span
                aria-hidden
                className={
                  // flex-1 fills available width; min-w lets it compress
                  // down to a sliver before any dot or current label gets
                  // touched. Result: no scrollbar at any width.
                  'h-px min-w-[4px] flex-1 ' +
                  COMPACT_CONNECTOR[stage.status]
                }
              />
            ) : null}
          </Fragment>
        );
      })}
    </ol>
  );
}

// --- existing horizontal (detail page) — unchanged behaviour ---------------

function HorizontalNode({ stage }: { stage: JourneyStage }) {
  const tone = STATUS_TONE[stage.status];
  return (
    // - h-[68px]   — uniform height so the row reads as a clean band
    // - min-w-0    — lets the grid track shrink without bleeding text out
    // - overflow-hidden — hard belt-and-suspenders against any future
    //                    content bleeding past the card border
    <li
      className={
        'flex h-[68px] min-w-0 flex-col justify-between overflow-hidden rounded-xl border bg-black/20 p-2 ' +
        tone.ring
      }
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className={'inline-block h-2 w-2 shrink-0 rounded-full ' + tone.dot}
        />
        <span
          className={
            'truncate font-mono text-[10px] uppercase tracking-[0.2em] ' +
            tone.label
          }
        >
          {String(stage.index).padStart(2, '0')} · {stage.label.toUpperCase()}
        </span>
      </div>
      <span
        className={
          'truncate font-mono text-[10px] uppercase tracking-[0.2em] ' +
          tone.label
        }
        title={STATUS_WORD[stage.status]}
      >
        {STATUS_WORD[stage.status]}
      </span>
    </li>
  );
}

function VerticalRow({
  stage,
  isLast,
}: {
  stage: JourneyStage;
  isLast: boolean;
}) {
  const tone = STATUS_TONE[stage.status];
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          aria-hidden
          className={'inline-block h-2.5 w-2.5 rounded-full ' + tone.dot}
        />
        {!isLast ? (
          <span
            aria-hidden
            className={
              'mt-1 inline-block w-px flex-1 ' +
              (stage.status === 'done' ? 'bg-forge-amber/60' : 'bg-white/10')
            }
          />
        ) : null}
      </div>
      <div
        className={
          'mb-1 flex flex-1 flex-col gap-0.5 rounded-lg border bg-black/20 p-3 ' +
          tone.ring
        }
      >
        <span
          className={
            'font-mono text-[10px] uppercase tracking-[0.3em] ' + tone.label
          }
        >
          {String(stage.index).padStart(2, '0')} · {stage.label}
        </span>
        <span className="text-sm text-forge-text/90">{stage.detail || '—'}</span>
      </div>
    </li>
  );
}
