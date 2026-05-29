'use client';

// ProjectsAi — the migrated /projects page client. Renders the count
// summary (computed from REAL data), the filter bar (preserves
// filterByMold semantics; chips operate on the already-loaded list), a
// tiny sort toggle, the responsive 4→2→1 card grid, and the FIRST-CLASS
// empty state (the app currently has zero projects — that's the state
// you'll actually see).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { ProjectCardAi } from '@/components/projects-ai/ProjectCardAi';
import { filterByMold, type ProjectMold } from '@/lib/molds';
import { projectVm, type ProjectVmStatus } from '@/lib/project-vm';
import type { ProjectCardData } from '@/lib/project-cards';

type MoldKey = 'all' | Exclude<ProjectMold, 'unclassified'>;
type StatusKey = 'all' | 'live' | 'forging' | 'gate';
type SortKey = 'newest' | 'oldest';

const MOLD_CHIPS: ReadonlyArray<{ key: MoldKey; label: string; dot?: string }> =
  [
    { key: 'all', label: 'All' },
    { key: 'agent', label: 'Agents', dot: 'bg-lq-aurora' },
    { key: 'system', label: 'Systems', dot: 'bg-lq-violet' },
    { key: 'software', label: 'Software', dot: 'bg-lq-mint' },
    { key: 'infrastructure', label: 'Infrastructure', dot: 'bg-lq-amber' },
  ];

const STATUS_CHIPS: ReadonlyArray<{ key: StatusKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'forging', label: 'Forging' },
  { key: 'gate', label: 'Gate' },
];

type Annotated = ProjectCardData & { _status: ProjectVmStatus };

export function ProjectsAi({ cards }: { cards: ProjectCardData[] }) {
  const [moldKey, setMoldKey] = useState<MoldKey>('all');
  const [statusKey, setStatusKey] = useState<StatusKey>('all');
  const [sort, setSort] = useState<SortKey>('newest');

  // Annotate once; status feeds both counts and the status filter.
  const annotated: Annotated[] = useMemo(
    () => cards.map((c) => ({ ...c, _status: projectVm(c).status })),
    [cards],
  );

  // Counts from ALL cards (not filtered) so the summary is the truth.
  const counts = useMemo(() => {
    const c = { total: cards.length, live: 0, forging: 0, gate: 0, paused: 0 };
    for (const a of annotated) {
      if (a._status === 'live') c.live++;
      else if (a._status === 'forging') c.forging++;
      else if (a._status === 'gate') c.gate++;
      else if (a._status === 'paused') c.paused++;
    }
    return c;
  }, [annotated, cards.length]);

  // Filter: REUSES filterByMold (the same pure helper the loader uses for
  // mold spaces) — semantics preserved, surface restyled.
  const filtered = useMemo(() => {
    let r: Annotated[] = annotated;
    if (moldKey !== 'all') r = filterByMold(r, moldKey) as Annotated[];
    if (statusKey !== 'all')
      r = r.filter((a) => a._status === statusKey);
    return r;
  }, [annotated, moldKey, statusKey]);

  // Sort. The loader returns newest-first; oldest = reverse.
  const sorted = useMemo(
    () => (sort === 'newest' ? filtered : [...filtered].reverse()),
    [filtered, sort],
  );

  const isFiltering = moldKey !== 'all' || statusKey !== 'all';

  return (
    <section className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-8 px-2 py-12 font-ui text-lq-ink">
      {/* Header. */}
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="font-code text-[11px] uppercase tracking-[0.35em] text-lq-aurora">
              Overview · /projects
            </span>
            <span
              aria-hidden
              className="h-px w-12 bg-gradient-to-r from-lq-aurora to-transparent"
            />
          </div>
          <h1 className="font-ui text-4xl font-extrabold tracking-[-0.02em] text-lq-ink sm:text-5xl">
            Projects
          </h1>
          {/* Count summary — colored numerals; render gracefully at zero. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-code text-[12px] text-lq-ink-faint">
            <span className="text-lq-ink-dim">
              <span className="text-lq-ink">{counts.total}</span> total
            </span>
            <span>·</span>
            <span>
              <span className="text-lq-mint">{counts.live}</span> live
            </span>
            <span>·</span>
            <span>
              <span className="text-lq-aurora">{counts.forging}</span> forging
            </span>
            <span>·</span>
            <span>
              <span className="text-lq-amber">{counts.gate}</span> gate
            </span>
            <span>·</span>
            <span>
              <span className="text-lq-ink-dim">{counts.paused}</span> paused
            </span>
          </p>
        </div>

        <div className="flex items-center gap-4">
          {/* Sort toggle. */}
          <div className="flex items-center gap-2 font-code text-[11px] uppercase tracking-[0.25em]">
            <span className="text-lq-ink-faint">Sort</span>
            <button
              type="button"
              onClick={() => setSort('newest')}
              className={
                sort === 'newest'
                  ? 'text-lq-aurora'
                  : 'text-lq-ink-dim hover:text-lq-ink'
              }
            >
              Newest
            </button>
            <span className="text-lq-ink-ghost">/</span>
            <button
              type="button"
              onClick={() => setSort('oldest')}
              className={
                sort === 'oldest'
                  ? 'text-lq-aurora'
                  : 'text-lq-ink-dim hover:text-lq-ink'
              }
            >
              Oldest
            </button>
          </div>

          <LiquidGlass
            as="a"
            href="/forge"
            variant="aurora"
            className="inline-flex items-center rounded-[14px] px-5 py-2.5 text-sm font-semibold"
          >
            + New forge
          </LiquidGlass>
        </div>
      </header>

      {/* Filter bar — mold chips + status chips. */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            Mold
          </span>
          {MOLD_CHIPS.map((chip) => {
            const active = moldKey === chip.key;
            return (
              <LiquidGlass
                key={chip.key}
                as="button"
                type="button"
                onClick={() => setMoldKey(chip.key)}
                variant={active ? 'aurora' : 'default'}
                className="inline-flex items-center gap-2 rounded-full px-3 py-1 font-code text-[11px]"
              >
                {chip.dot ? (
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rounded-full ${chip.dot}`}
                  />
                ) : null}
                <span>{chip.label}</span>
              </LiquidGlass>
            );
          })}
        </div>

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
      </div>

      {/* Grid or empty state. */}
      {sorted.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {sorted.map((card) => (
            <li key={card.project.id}>
              <ProjectCardAi card={card} />
            </li>
          ))}
        </ul>
      ) : counts.total === 0 ? (
        // PRIMARY empty state — the one you'll actually see today.
        <div className="flex flex-1 items-center justify-center py-10">
          <LiquidGlass
            as="div"
            className="flex w-full max-w-lg flex-col items-center gap-5 p-8 text-center font-ui"
          >
            <span className="font-code text-[10px] uppercase tracking-[0.4em] text-lq-aurora">
              Empty
            </span>
            <h2 className="font-ui text-2xl font-bold tracking-tight text-lq-ink">
              No projects yet.
            </h2>
            <p className="text-sm leading-relaxed text-lq-ink-dim">
              Describe what you want and the forge takes it from there —
              agents, systems, full apps, infrastructure. The forge detects
              the mold and asks before it ships.
            </p>
            <LiquidGlass
              as="a"
              href="/forge"
              variant="aurora"
              className="mt-1 inline-flex items-center rounded-[14px] px-6 py-3 text-sm font-semibold"
            >
              + Forge your first project →
            </LiquidGlass>
          </LiquidGlass>
        </div>
      ) : (
        // Secondary empty state — there ARE projects, just none match the chips.
        <div className="flex flex-1 items-center justify-center py-10">
          <LiquidGlass
            as="div"
            className="flex w-full max-w-md flex-col items-center gap-3 p-6 text-center font-ui"
          >
            <p className="text-sm text-lq-ink-dim">
              No projects match the current filters.
            </p>
            <button
              type="button"
              onClick={() => {
                setMoldKey('all');
                setStatusKey('all');
              }}
              className="font-code text-[11px] uppercase tracking-[0.3em] text-lq-aurora hover:text-lq-ink"
            >
              Reset filters
            </button>
          </LiquidGlass>
        </div>
      )}

      {/* Filtering-active microcopy when results exist + chips set. */}
      {isFiltering && sorted.length > 0 ? (
        <p className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
          showing {sorted.length} of {counts.total}
        </p>
      ) : null}
    </section>
  );
}
