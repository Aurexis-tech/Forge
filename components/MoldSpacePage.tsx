// A single mold space — the archive scoped to ONE mold. Header = mold
// name (display serif) + one-line plain description; then that mold's
// projects only (filtered by the resolved ProjectMold), newest-first;
// with a per-mold empty state. Shared by all four mold routes so the four
// pages stay thin. Same atmosphere + rhythm + motion as Home.

import Link from 'next/link';
import { EmberCard } from '@/components/forge/EmberCard';
import { SectionHeader } from '@/components/forge/SectionHeader';
import { ProjectCard } from '@/components/ProjectCard';
import { Reveal } from '@/components/Reveal';
import { requireUser } from '@/lib/auth';
import { MOTION } from '@/lib/forge-motion';
import { MOLD_META } from '@/lib/molds';
import { loadProjectCards } from '@/lib/project-cards';
import type { ProjectKind } from '@/lib/types';

function NewForgeAction() {
  return (
    <Link
      href="/forge"
      className="rounded-xl border border-forge-amber/40 bg-forge-amber/[0.06] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber transition hover:border-forge-amber/70 hover:bg-forge-amber/15 hover:shadow-amber"
    >
      + new forge
    </Link>
  );
}

export async function MoldSpacePage({ mold }: { mold: ProjectKind }) {
  const meta = MOLD_META[mold];
  const user = await requireUser();
  const cards = await loadProjectCards(user.id, { mold });

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 py-16">
      <Reveal>
        <SectionHeader
          level={1}
          eyebrow="mold"
          title={meta.title}
          subcopy={meta.description}
          action={<NewForgeAction />}
        />
      </Reveal>

      {cards.length === 0 ? (
        <Reveal delayMs={MOTION.revealStep}>
          <EmberCard tone="none">
            <p className="text-sm leading-relaxed text-forge-dim">
              {meta.emptyLine}
            </p>
          </EmberCard>
        </Reveal>
      ) : (
        <Reveal delayMs={MOTION.revealStep}>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {cards.map((card) => (
              <li key={card.project.id}>
                <ProjectCard {...card} />
              </li>
            ))}
          </ul>
        </Reveal>
      )}
    </section>
  );
}
