// JourneyPipelineAi — the AI-futuristic stage pipeline. Pure presentation:
// takes the real journey + the dot view-model and renders 8 dots with
// AI-palette colors per stage status. The SINGLE current stage wears an
// amber breathing rim (the only infinite loop on this surface). Everything
// else is bounded transitions.

import { pipelineDotsVm, type WorkshopColor } from '@/lib/workshop-vm';
import type { Journey } from '@/lib/journey';
import styles from './workshop.module.css';

const COLOR_DOT: Readonly<Record<WorkshopColor, string>> = {
  mint: 'bg-lq-mint',
  aurora: 'bg-lq-aurora',
  amber: 'bg-lq-amber',
  rose: 'bg-lq-rose',
  'ink-dim': 'bg-lq-ink-faint',
};

const COLOR_TEXT: Readonly<Record<WorkshopColor, string>> = {
  mint: 'text-lq-mint',
  aurora: 'text-lq-aurora',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
  'ink-dim': 'text-lq-ink-faint',
};

const COLOR_RING: Readonly<Record<WorkshopColor, string>> = {
  mint: 'ring-lq-mint/40',
  aurora: 'ring-lq-aurora/40',
  amber: 'ring-lq-amber/50',
  rose: 'ring-lq-rose/40',
  'ink-dim': 'ring-lq-line',
};

export function JourneyPipelineAi({ journey }: { journey: Journey }) {
  const dots = pipelineDotsVm(journey);
  const cursorIndex = Math.max(
    0,
    journey.stages.findIndex((s) => s.id === journey.cursor.id),
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Cursor line — real "stage NN · label · detail". */}
      <p className="font-code text-[10px] uppercase tracking-[0.35em] text-lq-aurora">
        journey · stage {String(journey.cursor.index).padStart(2, '0')} ·{' '}
        <span className="text-lq-ink">{journey.cursor.label}</span>
        {journey.cursor.detail ? (
          <span className="text-lq-ink-faint"> · {journey.cursor.detail}</span>
        ) : null}
      </p>

      {/* Dots + connectors row. */}
      <ol
        aria-label="Forge journey"
        className="flex w-full items-center gap-2"
      >
        {dots.map((d, i) => {
          const isFirst = i === 0;
          return (
            <li
              key={d.id}
              className="flex flex-1 items-center gap-2"
              aria-current={d.pulse ? 'step' : undefined}
            >
              {/* Connector to the previous dot (skip on the first one). */}
              {!isFirst ? (
                <span
                  aria-hidden
                  className={styles.pipelineConnector}
                  style={{ opacity: i <= cursorIndex ? 0.6 : 0.25 }}
                />
              ) : null}
              <div className="flex flex-col items-center gap-1.5">
                <span
                  className={
                    'inline-flex h-2.5 w-2.5 items-center justify-center rounded-full ring-2 ring-offset-0 transition-all ' +
                    COLOR_DOT[d.color] +
                    ' ' +
                    COLOR_RING[d.color] +
                    ' ' +
                    (d.pulse ? styles.activeRim : '')
                  }
                />
                <span
                  className={
                    'font-code text-[9px] uppercase tracking-[0.25em] ' +
                    (d.pulse ? COLOR_TEXT[d.color] : 'text-lq-ink-faint')
                  }
                >
                  {String(d.index).padStart(2, '0')} {d.label}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
