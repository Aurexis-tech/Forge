// One project card — used by Home (all molds) and each mold space. The
// card is mold-agnostic: it always shows its mold badge (incl. the
// "detecting…" state) next to the journey stage pill.
//
// Forge design language: the card is an EmberCard whose inner glow reads
// "warm → cool by recency" (projectCardTone) — a just-started forge is
// still warm on the anvil, a live one has cooled to cyan, the long tail
// sits quiet. The stage pill is a HeatBadge (cool when live, dim
// otherwise); the mold badge is already a HeatBadge via MoldBadge. The
// whole card lifts to a heat-glow border on hover (it's a forge you can
// reach into).

import Link from 'next/link';
import { EmberCard } from '@/components/forge/EmberCard';
import { HeatBadge } from '@/components/forge/HeatBadge';
import { JourneyStepper } from '@/components/journey/JourneyStepper';
import { MoldBadge } from '@/components/MoldBadge';
import { projectCardTone } from '@/lib/forge-heat';
import type { Journey } from '@/lib/journey';
import type { ProjectMold } from '@/lib/molds';
import type { Project } from '@/lib/types';

export interface ProjectCardData {
  project: Project;
  journey: Journey;
  mold: ProjectMold;
}

export function ProjectCard({ project, journey, mold }: ProjectCardData) {
  const tone = projectCardTone({
    isLive: journey.isLive,
    createdAtMs: new Date(project.created_at).getTime(),
  });
  return (
    <Link
      href={'/projects/' + project.id}
      className="group block h-full"
      aria-label={'Open ' + project.name}
    >
      <EmberCard
        tone={tone}
        className="h-full transition duration-200 group-hover:-translate-y-1 group-hover:border-heat-glow/50 group-hover:shadow-amber"
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2
                className="truncate text-lg font-medium text-forge-text"
                title={project.name}
              >
                {project.name}
              </h2>
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                {new Date(project.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <HeatBadge tone={journey.isLive ? 'cool' : 'dim'} dot={journey.isLive}>
                {journey.isLive ? 'live' : journey.cursor.label}
              </HeatBadge>
              <MoldBadge mold={mold} />
            </div>
          </div>
          <JourneyStepper journey={journey} layout="compact" />
        </div>
      </EmberCard>
    </Link>
  );
}
