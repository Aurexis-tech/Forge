'use client';

// ProjectsAi — the migrated /projects page client. Two branches:
//
//   POPULATED — when the REAL project list has anything: the v2 "Workspace"
//   header (eyebrow + h1 + Newest/Oldest sort + "+ New forge" CTA), a v2
//   STAT ROW (Active forges · Spend this month · Live · Builds total — all
//   real), the Mold + Status filter chips, and the responsive 4→2→1
//   ProjectCardAi grid (+ filter-mismatch secondary empty).
//
//   EMPTY (first-run, zero REAL projects) — a centered hero on the ambient
//   backdrop + the four-mold quick-start gallery reused from the landing.
//   Header chrome / stat row / filters are suppressed (inert at zero).

import { useMemo, useState } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { MoldGallery } from '@/components/landing-ai/MoldGallery';
import { ProjectCardAi } from '@/components/projects-ai/ProjectCardAi';
import { filterByMold, type ProjectMold } from '@/lib/molds';
import { projectVm, type ProjectVmStatus } from '@/lib/project-vm';
import type { ProjectCardData, DashboardStats } from '@/lib/project-cards';

type MoldKey = 'all' | Exclude<ProjectMold, 'unclassified'>;
type StatusKey = 'all' | 'live' | 'forging' | 'gate';
type SortKey = 'newest' | 'oldest';

const MOLD_CHIPS: ReadonlyArray<{ key: MoldKey; label: string; dot?: string }> =
  [
    { key: 'all', label: 'All' },
    { key: 'agent', label: 'Agents', dot: 'bg-lq-aurora' },
    { key: 'system', label: 'Systems', dot: 'bg-lq-blue' },
    { key: 'software', label: 'Software', dot: 'bg-lq-violet' },
    { key: 'infrastructure', label: 'Infrastructure', dot: 'bg-lq-magenta' },
  ];

const STATUS_CHIPS: ReadonlyArray<{ key: StatusKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'forging', label: 'Forging' },
  { key: 'gate', label: 'Gate' },
];

type Annotated = ProjectCardData & { _status: ProjectVmStatus };

export function ProjectsAi({
  cards,
  stats,
}: {
  cards: ProjectCardData[];
  stats: DashboardStats;
}) {
  // FIRST-RUN BRANCH — render the beautiful empty/first-run state and skip
  // all populated chrome (header, stat row, filters). REAL-data-only.
  if (cards.length === 0) {
    return <ProjectsEmptyState />;
  }

  return <ProjectsPopulated cards={cards} stats={stats} />;
}

// ===========================================================================
// First-run / empty state — centered hero + quick-start mold gallery
// ===========================================================================

function ProjectsEmptyState() {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-12 px-2 py-16 font-ui text-lq-ink">
      {/* Centered hero. */}
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="flex items-center gap-3">
          <span aria-hidden className="h-px w-9 bg-lq-aurora/60" />
          <span className="font-code text-[11px] uppercase tracking-[0.35em] text-lq-aurora">
            Your workshop · empty
          </span>
          <span
            aria-hidden
            className="h-px w-9 bg-gradient-to-l from-lq-aurora/60 to-transparent"
          />
        </div>

        <h1 className="font-ui text-5xl font-extrabold tracking-[-0.02em] text-lq-ink sm:text-6xl">
          Nothing forged yet.
        </h1>

        <p className="max-w-[620px] text-base leading-relaxed text-lq-ink-dim">
          Describe what you want in a sentence — an agent, a system, a full
          app, or a piece of infrastructure — and the forge designs it,
          builds it in a sandbox, and{' '}
          <span className="text-lq-ink">asks before anything ships.</span>
        </p>

        <LiquidGlass
          as="a"
          href="/forge"
          variant="aurora"
          className="mt-1 inline-flex items-center rounded-[14px] px-7 py-3 text-base font-semibold"
        >
          Forge your first project →
        </LiquidGlass>
      </div>

      {/* Quick-start gallery — the four mold cards from the landing. */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 px-1">
          <span className="font-code text-[10px] uppercase tracking-[0.35em] text-lq-ink-faint">
            Start from a mold
          </span>
          <span
            aria-hidden
            className="h-px flex-1 bg-gradient-to-r from-lq-line to-transparent"
          />
        </div>
        <MoldGallery />
      </div>
    </section>
  );
}

// ===========================================================================
// Stat row — v2 workspace summary. All values REAL.
// ===========================================================================

function Stat({
  value,
  label,
  valueClass,
}: {
  value: string;
  label: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-[14px] border border-lq-line bg-[rgba(255,255,255,0.025)] p-4">
      <div
        className={
          'font-ui text-[26px] font-extrabold leading-none tracking-[-0.02em] text-lq-ink ' +
          (valueClass ?? '')
        }
      >
        {value}
      </div>
      <div className="mt-2 font-code text-[11px] uppercase tracking-[0.12em] text-lq-ink-faint">
        {label}
      </div>
    </div>
  );
}

// ===========================================================================
// Populated branch
// ===========================================================================

function ProjectsPopulated({
  cards,
  stats,
}: {
  cards: ProjectCardData[];
  stats: DashboardStats;
}) {
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

  const filtered = useMemo(() => {
    let r: Annotated[] = annotated;
    if (moldKey !== 'all') r = filterByMold(r, moldKey) as Annotated[];
    if (statusKey !== 'all') r = r.filter((a) => a._status === statusKey);
    return r;
  }, [annotated, moldKey, statusKey]);

  const sorted = useMemo(
    () => (sort === 'newest' ? filtered : [...filtered].reverse()),
    [filtered, sort],
  );

  const isFiltering = moldKey !== 'all' || statusKey !== 'all';

  return (
    <section className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-7 px-2 py-12 font-ui text-lq-ink">
      {/* Header. */}
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="font-code text-[11px] uppercase tracking-[0.35em] text-lq-aurora">
              Workspace
            </span>
            <span
              aria-hidden
              className="h-px w-12 bg-gradient-to-r from-lq-aurora to-transparent"
            />
          </div>
          <h1 className="font-ui text-4xl font-extrabold tracking-[-0.02em] text-lq-ink sm:text-5xl">
            Projects
          </h1>
        </div>

        <div className="flex items-center gap-4">
          {/* Sort toggle. */}
          <div className="flex items-center gap-2 font-code text-[11px] uppercase tracking-[0.25em]">
            <span className="text-lq-ink-faint">Sort</span>
            <button
              type="button"
              onClick={() => setSort('newest')}
              className={
                'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60 ' +
                (sort === 'newest'
                  ? 'text-lq-aurora'
                  : 'text-lq-ink-dim hover:text-lq-ink')
              }
            >
              Newest
            </button>
            <span className="text-lq-ink-ghost">/</span>
            <button
              type="button"
              onClick={() => setSort('oldest')}
              className={
                'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60 ' +
                (sort === 'oldest'
                  ? 'text-lq-aurora'
                  : 'text-lq-ink-dim hover:text-lq-ink')
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

      {/* Stat row — all REAL: active forges + this-month spend + live + builds. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat value={String(counts.total - counts.paused)} label="Active forges" />
        <Stat
          value={'$' + stats.monthlySpendUsd.toFixed(2)}
          label="Spend · this month"
        />
        <Stat
          value={String(counts.live)}
          label="Live"
          valueClass="text-lq-mint"
        />
        <Stat value={String(stats.totalBuilds)} label="Builds · total" />
      </div>

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

      {/* Grid or filter-mismatch secondary empty state. */}
      {sorted.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {sorted.map((card) => (
            <li key={card.project.id}>
              <ProjectCardAi card={card} />
            </li>
          ))}
        </ul>
      ) : (
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
              className="rounded font-code text-[11px] uppercase tracking-[0.3em] text-lq-aurora transition-colors hover:text-lq-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60"
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
