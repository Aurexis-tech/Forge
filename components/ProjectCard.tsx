// One project card — used by Home (all molds) and each mold space. The
// card is mold-agnostic: it always shows its mold badge (incl. the
// "detecting…" state) next to the journey stage pill. Extracted verbatim
// from the old projects archive so the look is unchanged; the only
// addition is that EVERY card now wears a MoldBadge (the archive
// previously hid it for agents).

import Link from 'next/link';
import { GlassPanel } from '@/components/GlassPanel';
import { JourneyStepper } from '@/components/journey/JourneyStepper';
import { MoldBadge } from '@/components/MoldBadge';
import type { Journey } from '@/lib/journey';
import type { ProjectMold } from '@/lib/molds';
import type { Project } from '@/lib/types';

export interface ProjectCardData {
  project: Project;
  journey: Journey;
  mold: ProjectMold;
}

export function ProjectCard({ project, journey, mold }: ProjectCardData) {
  return (
    <Link
      href={'/projects/' + project.id}
      className="group block h-full"
      aria-label={'Open ' + project.name}
    >
      <GlassPanel className="h-full transition group-hover:border-forge-amber/40 group-hover:shadow-amber">
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
              <span
                className={
                  'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] ' +
                  (journey.isLive
                    ? 'border-forge-amber/60 text-forge-amber'
                    : 'border-white/10 text-forge-dim')
                }
              >
                {journey.isLive ? 'live' : journey.cursor.label}
              </span>
              <MoldBadge mold={mold} />
            </div>
          </div>
          <JourneyStepper journey={journey} layout="compact" />
        </div>
      </GlassPanel>
    </Link>
  );
}
