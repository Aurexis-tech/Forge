// MoldSpaceAi — the parameterized server component every mold-space route
// renders. Loads the user's full ProjectCardData[] once (the loader is
// already capped at 100, so a single call gives us BOTH the switcher's
// per-mold counts AND this mold's filtered grid without extra queries),
// derives the aggregate stat bar from REAL fields only (no fabricated
// runs/uptime/cost — see lib/project-vm.aggregateMoldStats), and hands the
// current mold's cards to the client MoldGrid (chips + grid + empty).
//
// The (app) backdrop + AiNav are provided by the AppBackdrop /
// AppShellHeader switches (these four routes are in MIGRATED_ROUTES).

import Link from 'next/link';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { MoldGrid } from '@/components/projects-ai/MoldGrid';
import { requireUser } from '@/lib/auth';
import { filterByMold } from '@/lib/molds';
import {
  MOLD_IDENTITIES,
  MOLD_ORDER,
  type MoldAccent,
} from '@/lib/mold-identity';
import { loadProjectCards } from '@/lib/project-cards';
import { aggregateMoldStats } from '@/lib/project-vm';
import type { ProjectKind } from '@/lib/types';

const ACCENT_BG: Record<MoldAccent, string> = {
  aurora: 'bg-lq-aurora',
  violet: 'bg-lq-violet',
  mint: 'bg-lq-mint',
  amber: 'bg-lq-amber',
};
const ACCENT_TEXT: Record<MoldAccent, string> = {
  aurora: 'text-lq-aurora',
  violet: 'text-lq-violet',
  mint: 'text-lq-mint',
  amber: 'text-lq-amber',
};

export async function MoldSpaceAi({ mold }: { mold: ProjectKind }) {
  const user = await requireUser();
  const allCards = await loadProjectCards(user.id);

  // Per-mold counts for the switcher (one query, deterministic split).
  const countsByMold = Object.fromEntries(
    MOLD_ORDER.map(
      (m) => [m, filterByMold(allCards, m).length] as const,
    ),
  ) as Record<ProjectKind, number>;

  // This mold's projects + headline aggregate (real fields only).
  const currentCards = filterByMold(allCards, mold);
  const aggregate = aggregateMoldStats(currentCards);

  const identity = MOLD_IDENTITIES[mold];

  return (
    <section className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-8 px-2 py-12 font-ui text-lq-ink">
      {/* Identity header + aggregate bar. */}
      <header className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span
                className={`font-code text-[11px] uppercase tracking-[0.35em] ${ACCENT_TEXT[identity.accent]}`}
              >
                {identity.eyebrow}
              </span>
              <span
                aria-hidden
                className={`h-px w-12 bg-gradient-to-r from-current to-transparent ${ACCENT_TEXT[identity.accent]}`}
              />
            </div>
            <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
              <h1 className="font-ui text-4xl font-extrabold tracking-[-0.02em] text-lq-ink sm:text-5xl">
                {identity.name}
              </h1>
              <span className="font-code text-[12px] uppercase tracking-[0.25em] text-lq-ink-faint">
                {identity.tagline}
              </span>
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-lq-ink-dim">
              {identity.description}
            </p>
          </div>

          {/* Aggregate stat bar — only the four derivable counts. */}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-code text-[12px] text-lq-ink-faint">
            <span className="text-lq-ink-dim">
              <span className="text-lq-ink">{aggregate.total}</span> total
            </span>
            <span>·</span>
            <span>
              <span className="text-lq-mint">{aggregate.live}</span> live
            </span>
            <span>·</span>
            <span>
              <span className={ACCENT_TEXT[identity.accent]}>
                {aggregate.forging}
              </span>{' '}
              forging
            </span>
            <span>·</span>
            <span>
              <span className="text-lq-amber">{aggregate.gate}</span> gate
            </span>
          </p>
        </div>

        {/* Mold switcher — four tabs, current in its own accent, each with
            its real count. The intake is mold-agnostic by design, so the
            "+ Forge new <mold>" CTA is a plain /forge link. */}
        <div className="flex flex-wrap items-center gap-2">
          {MOLD_ORDER.map((m) => {
            const id = MOLD_IDENTITIES[m];
            const active = m === mold;
            return (
              <Link
                key={m}
                href={id.href}
                aria-current={active ? 'page' : undefined}
                className="group"
              >
                <LiquidGlass
                  as="div"
                  variant={active ? 'aurora' : 'default'}
                  className={
                    'inline-flex items-center gap-2 rounded-full px-3 py-1 font-code text-[11px] ' +
                    (active ? ACCENT_TEXT[id.accent] : '')
                  }
                >
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rounded-full ${ACCENT_BG[id.accent]}`}
                  />
                  <span>{id.name}</span>
                  <span className="text-lq-ink-faint">
                    {countsByMold[m]}
                  </span>
                </LiquidGlass>
              </Link>
            );
          })}
          <span className="ml-auto">
            <LiquidGlass
              as="a"
              href="/forge"
              variant="aurora"
              className="inline-flex items-center rounded-[14px] px-5 py-2 text-sm font-semibold"
            >
              {identity.ctaLabel}
            </LiquidGlass>
          </span>
        </div>
      </header>

      {/* Status chips + grid + empty state (client). */}
      <MoldGrid cards={currentCards} mold={mold} />
    </section>
  );
}
