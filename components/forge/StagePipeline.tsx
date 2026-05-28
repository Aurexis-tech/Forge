// StagePipeline — the INTENT → … → LIVE strip, read as a COOLING process.
//
//   completed stages (before active) → cooled to cyan (the heat has left)
//   the active stage (just-acted)     → molten, the hottest point, glowing
//   pending stages (after active)     → dim, not yet reached
//   the final LIVE stage, once active → settles to cool cyan
//
// This is the visual spine of the forge: heat marks where you just acted,
// then cools as the work settles. Presentational + deterministic — pass
// the stages + the active index. The active dot's pulse is frozen under
// prefers-reduced-motion (global rule), leaving a solid molten dot.
//
// Server component — pure presentation.

export interface PipelineStage {
  id: string;
  label: string;
}

// The canonical forge pipeline (mirrors lib/journey.ts STAGE_DEFS).
export const CANONICAL_STAGES: ReadonlyArray<PipelineStage> = [
  { id: 'intent', label: 'Intent' },
  { id: 'spec', label: 'Spec' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'Code' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'repo', label: 'Repo' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'live', label: 'Live' },
];

type Temp = 'cooled' | 'molten' | 'pending';

function tempFor(index: number, activeIndex: number, isLast: boolean): Temp {
  if (index < activeIndex) return 'cooled';
  if (index > activeIndex) return 'pending';
  // active: the final stage settles cool ("live"); any earlier active
  // stage is molten (just-acted heat).
  return isLast ? 'cooled' : 'molten';
}

const DOT: Record<Temp, string> = {
  // Molten = hottest, glowing + a slow pulse (frozen by reduced-motion).
  molten:
    'bg-heat-molten shadow-[0_0_14px_2px_rgba(255,186,115,0.7)] animate-pulse',
  // Cooled = the heat has settled to cyan.
  cooled: 'bg-cool-cyan/80 shadow-[0_0_8px_1px_rgba(79,212,240,0.45)]',
  // Pending = unlit.
  pending: 'bg-white/15',
};

const TEXT: Record<Temp, string> = {
  molten: 'text-heat-molten',
  cooled: 'text-cool-cyan/80',
  pending: 'text-forge-faint',
};

export function StagePipeline({
  stages = CANONICAL_STAGES,
  activeIndex,
  className = '',
}: {
  stages?: ReadonlyArray<PipelineStage>;
  activeIndex: number;
  className?: string;
}) {
  return (
    <ol
      aria-label="Forge pipeline"
      className={
        'flex w-full items-start justify-between gap-1 ' + className
      }
    >
      {stages.map((stage, i) => {
        const temp = tempFor(i, activeIndex, i === stages.length - 1);
        return (
          <li
            key={stage.id}
            className="flex min-w-0 flex-1 flex-col items-center gap-2"
          >
            <div className="flex w-full items-center">
              {/* left connector (cooled up to the active node) */}
              <span
                aria-hidden
                className={
                  'h-px flex-1 ' +
                  (i === 0
                    ? 'opacity-0'
                    : i <= activeIndex
                      ? 'bg-cool-cyan/30'
                      : 'bg-white/8')
                }
              />
              <span
                aria-hidden
                className={'h-2 w-2 shrink-0 rounded-full ' + DOT[temp]}
              />
              {/* right connector */}
              <span
                aria-hidden
                className={
                  'h-px flex-1 ' +
                  (i === stages.length - 1
                    ? 'opacity-0'
                    : i < activeIndex
                      ? 'bg-cool-cyan/30'
                      : 'bg-white/8')
                }
              />
            </div>
            <span
              className={
                'font-mono text-[9px] uppercase tracking-[0.2em] ' + TEXT[temp]
              }
            >
              {stage.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
