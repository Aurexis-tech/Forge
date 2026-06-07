// SectionHeading — shared eyebrow + heading + intro lockup for the landing-ai
// content sections (How it works, Why it's safe, One run, Pricing, FAQ). Mirrors
// the hero's treatment: a font-code accent label, a short gradient rule, then an
// Inter display heading and a dimmed intro line.

import { type ReactNode } from 'react';

type Accent = 'aurora' | 'violet' | 'mint' | 'amber' | 'rose';

// Literal class strings (Tailwind scans source for full names — never build
// these dynamically). Matches the DOT/TEXT records in MoldGallery.
const ACCENT_TEXT: Record<Accent, string> = {
  aurora: 'text-lq-aurora',
  violet: 'text-lq-violet',
  mint: 'text-lq-mint',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
};
const ACCENT_LINE: Record<Accent, string> = {
  aurora: 'from-lq-aurora',
  violet: 'from-lq-violet',
  mint: 'from-lq-mint',
  amber: 'from-lq-amber',
  rose: 'from-lq-rose',
};

interface Props {
  eyebrow: string;
  title: ReactNode;
  intro?: ReactNode;
  accent?: Accent;
  align?: 'left' | 'center';
}

export function SectionHeading({
  eyebrow,
  title,
  intro,
  accent = 'aurora',
  align = 'left',
}: Props) {
  const centered = align === 'center';
  return (
    <div className={centered ? 'flex flex-col items-center text-center' : 'flex flex-col'}>
      <div className="flex items-center gap-3">
        <span
          className={
            'font-code text-[11px] uppercase tracking-[0.35em] ' + ACCENT_TEXT[accent]
          }
        >
          {eyebrow}
        </span>
        <span
          aria-hidden
          className={'h-px w-12 bg-gradient-to-r to-transparent ' + ACCENT_LINE[accent]}
        />
      </div>
      <h2 className="mt-6 max-w-3xl font-ui text-4xl font-extrabold leading-[1.03] tracking-[-0.02em] text-lq-ink sm:text-5xl">
        {title}
      </h2>
      {intro ? (
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-lq-ink-dim">{intro}</p>
      ) : null}
    </div>
  );
}
