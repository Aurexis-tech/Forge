// HOME / OVERVIEW. Lists every forge newest-first across all molds —
// INCLUDING brand-new projects whose type the engine is still detecting
// (they wear the "detecting…" badge). This is the safety net: a fresh
// forge is always visible here while its mold is determined, then it also
// appears in its mold space once classified.

import Link from 'next/link';
import { EmberCard } from '@/components/forge/EmberCard';
import { SectionHeader } from '@/components/forge/SectionHeader';
import { ProjectCard } from '@/components/ProjectCard';
import { Reveal } from '@/components/Reveal';
import { requireUser } from '@/lib/auth';
import { MOTION } from '@/lib/forge-motion';
import { loadProjectCards } from '@/lib/project-cards';

export const dynamic = 'force-dynamic';

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

export default async function HomePage() {
  const user = await requireUser();
  const cards = await loadProjectCards(user.id);

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 py-16">
      <Reveal>
        <SectionHeader
          level={1}
          eyebrow="overview"
          title="All projects"
          subcopy="Every forge you’ve started, newest first — across all four molds, including ones still being detected."
          action={<NewForgeAction />}
        />
      </Reveal>

      {cards.length === 0 ? (
        <Reveal delayMs={MOTION.revealStep}>
          <EmberCard tone="none">
            <p className="text-sm leading-relaxed text-forge-dim">
              Nothing forged yet. Head to{' '}
              <Link href="/forge" className="text-forge-amber hover:underline">
                New Forge
              </Link>{' '}
              and describe what you want to build — an agent, a system, a full
              app, or infrastructure. The Forge detects which.
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
