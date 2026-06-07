'use client';

// MoldGrid — the per-mold client surface: status chips (within this mold),
// the responsive grid of REUSED ProjectCardAi, and a mold-tinted empty
// state. Receives the already-filtered current-mold cards from the server
// MoldSpaceAi. Same chip semantics as ProjectsAi, scoped down.

import { useMemo, useState } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { ProjectCardAi } from '@/components/projects-ai/ProjectCardAi';
import { projectVm, type ProjectVmStatus } from '@/lib/project-vm';
import { MOLD_IDENTITIES, type MoldAccent } from '@/lib/mold-identity';
import type { ProjectCardData } from '@/lib/project-cards';
import type { ProjectKind } from '@/lib/types';

type StatusKey = 'all' | 'live' | 'forging' | 'gate';

const STATUS_CHIPS: ReadonlyArray<{ key: StatusKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'forging', label: 'Forging' },
  { key: 'gate', label: 'Gate' },
];

const ACCENT_BORDER: Record<MoldAccent, string> = {
  aurora: 'border-l-lq-aurora',
  blue: 'border-l-lq-blue',
  violet: 'border-l-lq-violet',
  magenta: 'border-l-lq-magenta',
};
const ACCENT_TEXT: Record<MoldAccent, string> = {
  aurora: 'text-lq-aurora',
  blue: 'text-lq-blue',
  violet: 'text-lq-violet',
  magenta: 'text-lq-magenta',
};

type Annotated = ProjectCardData & { _status: ProjectVmStatus };

export function MoldGrid({
  cards,
  mold,
}: {
  cards: ProjectCardData[];
  mold: ProjectKind;
}) {
  const identity = MOLD_IDENTITIES[mold];
  const [statusKey, setStatusKey] = useState<StatusKey>('all');

  const annotated: Annotated[] = useMemo(
    () => cards.map((c) => ({ ...c, _status: projectVm(c).status })),
    [cards],
  );

  const filtered = useMemo(
    () =>
      statusKey === 'all'
        ? annotated
        : annotated.filter((a) => a._status === statusKey),
    [annotated, statusKey],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Status chips (scoped to this mold). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
          Status
        </span>
        {STATUS_CHIPS.map((chip) => {
          const active = statusKey === chip.key;
          return (
            <LiquidGlass
              key={chip.key}
              as="button"
              type="button"
              onClick={() => setStatusKey(chip.key)}
              variant={active ? 'aurora' : 'default'}
              className="inline-flex items-center rounded-full px-3 py-1 font-code text-[11px]"
            >
              {chip.label}
            </LiquidGlass>
          );
        })}
      </div>

      {/* Grid or empty state. */}
      {filtered.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {filtered.map((card) => (
            <li key={card.project.id}>
              <ProjectCardAi card={card} />
            </li>
          ))}
        </ul>
      ) : cards.length === 0 ? (
        // PRIMARY mold-tinted empty state — the one you'll actually see.
        <div className="flex flex-1 items-center justify-center py-10">
          <LiquidGlass
            as="div"
            className={`flex w-full max-w-lg flex-col items-center gap-5 border-l-2 p-8 text-center font-ui ${ACCENT_BORDER[identity.accent]}`}
          >
            <span
              className={`font-code text-[10px] uppercase tracking-[0.4em] ${ACCENT_TEXT[identity.accent]}`}
            >
              {identity.eyebrow}
            </span>
            <h2 className="font-ui text-2xl font-bold tracking-tight text-lq-ink">
              {identity.emptyHeading}
            </h2>
            <p className="text-sm leading-relaxed text-lq-ink-dim">
              {identity.emptyInvitation}
            </p>
            <LiquidGlass
              as="a"
              href="/forge"
              variant="aurora"
              className="mt-1 inline-flex items-center rounded-[14px] px-6 py-3 text-sm font-semibold"
            >
              {identity.ctaLabel} →
            </LiquidGlass>
          </LiquidGlass>
        </div>
      ) : (
        // Secondary state — projects exist for this mold but none match the chips.
        <div className="flex flex-1 items-center justify-center py-10">
          <LiquidGlass
            as="div"
            className="flex w-full max-w-md flex-col items-center gap-3 p-6 text-center font-ui"
          >
            <p className="text-sm text-lq-ink-dim">
              No {identity.name.toLowerCase()} match the current filters.
            </p>
            <button
              type="button"
              onClick={() => setStatusKey('all')}
              className="rounded font-code text-[11px] uppercase tracking-[0.3em] text-lq-aurora transition-colors hover:text-lq-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60"
            >
              Reset
            </button>
          </LiquidGlass>
        </div>
      )}
    </div>
  );
}
