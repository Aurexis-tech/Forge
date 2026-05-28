// HeatBadge — the canonical pill primitive. Centralises the badge shape
// (hairline border, mono uppercase, wide tracking) so mold badges + stage
// pills + status chips all read identically; only the TINT varies.
//
// `tone` is the border+text tint (a className cluster) — pass one of the
// HEAT_TONES (heat-spectrum or cool) or any brand tone string. An
// optional leading `dot` renders a status dot in the same tone.
//
// Server component — pure presentation.

import type { ReactNode } from 'react';

// Named tints — the heat spectrum + the cool settle + a quiet neutral.
// Literal class strings (Tailwind JIT sees them in source).
export const HEAT_TONES = {
  coal: 'border-heat-coal/40 text-heat-coal',
  ember: 'border-heat-ember/40 text-heat-ember',
  glow: 'border-heat-glow/50 text-heat-glow',
  molten: 'border-heat-molten/60 text-heat-molten',
  spark: 'border-heat-spark/60 text-heat-spark',
  cool: 'border-cool-cyan/40 text-cool-cyan',
  dim: 'border-white/10 text-forge-dim',
} as const;

export type HeatTone = keyof typeof HEAT_TONES;

export function HeatBadge({
  children,
  tone,
  dot = false,
  className = '',
}: {
  children: ReactNode;
  /** A HEAT_TONES key, or a raw border+text tint className. */
  tone: HeatTone | string;
  dot?: boolean;
  className?: string;
}) {
  const tint = tone in HEAT_TONES ? HEAT_TONES[tone as HeatTone] : tone;
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ' +
        'font-mono text-[9px] uppercase tracking-[0.25em] ' +
        tint +
        (className ? ' ' + className : '')
      }
    >
      {dot ? (
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-current"
        />
      ) : null}
      {children}
    </span>
  );
}
