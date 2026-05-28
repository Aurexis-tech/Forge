// SectionHeader — the canonical eyebrow → display-serif heading rhythm.
// The ".num" eyebrow is IBM Plex Mono, wide-tracked, cyan (a cool accent
// — restraint; heat is reserved for action). The title is Fraunces (via
// the global heading rule). Body subcopy is Spectral. An optional action
// (e.g. a ForgeButton or "+ new forge") sits to the right.
//
// `level` picks the heading tag: 1 for page titles, 2 for in-page
// sections. Server component — pure presentation.

import type { ReactNode } from 'react';

export function SectionHeader({
  eyebrow,
  title,
  subcopy,
  action,
  level = 2,
}: {
  eyebrow: string;
  title: ReactNode;
  subcopy?: ReactNode;
  action?: ReactNode;
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-forge-cyan">
          {eyebrow}
        </p>
        <Heading className="text-balance text-3xl font-medium text-forge-text sm:text-4xl">
          {title}
        </Heading>
        {subcopy ? (
          <p className="max-w-xl text-sm leading-relaxed text-forge-dim">
            {subcopy}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
