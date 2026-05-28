// EmberCard — the surface primitive. A calm, hairline-bordered panel
// (the refined-restraint default) with an OPTIONAL faint inner ember:
//   tone="warm" → a soft amber glow in the corner (recent / live / hot)
//   tone="cool" → a soft cyan glow (settled / inactive-but-healthy)
//   tone="none" → just the hairline (the quiet default)
//
// Heat stays meaningful: most cards are "none". Reserve "warm" for cards
// that represent something recently-acted-on or live. Optional `hover`
// adds the amber border-glow lift used on clickable cards.
//
// Server component — pure presentation.

import type { HTMLAttributes, ReactNode } from 'react';

type EmberTone = 'none' | 'warm' | 'cool';

interface EmberCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  tone?: EmberTone;
  hover?: boolean;
}

const INNER: Record<EmberTone, string | null> = {
  none: null,
  warm: 'radial-gradient(70% 60% at 100% 0%, rgba(255,154,77,0.09), transparent 60%)',
  cool: 'radial-gradient(70% 60% at 100% 0%, rgba(79,212,240,0.07), transparent 60%)',
};

export function EmberCard({
  children,
  tone = 'none',
  hover = false,
  className = '',
  ...rest
}: EmberCardProps) {
  const inner = INNER[tone];
  return (
    <div
      {...rest}
      className={
        'relative overflow-hidden rounded-2xl border border-[color:var(--line)] ' +
        'bg-forge-panel p-6 shadow-glass backdrop-blur-md ' +
        (hover
          ? 'forge-lift hover:border-heat-glow/40 hover:shadow-amber '
          : '') +
        className
      }
    >
      {inner ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: inner }}
        />
      ) : null}
      <div className="relative">{children}</div>
    </div>
  );
}
