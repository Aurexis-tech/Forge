import Link from 'next/link';
import { GlassPanel } from '@/components/GlassPanel';
import { JourneyStepper } from '@/components/journey/JourneyStepper';
import { requireUser } from '@/lib/auth';
import { deriveJourney, type Journey } from '@/lib/journey';
import { getServerSupabase } from '@/lib/supabase';
import type {
  AgentRuntime,
  Build,
  Plan,
  Project,
  Spec,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

interface ProjectCard {
  project: Project;
  journey: Journey;
}

async function loadProjectCards(userId: string): Promise<ProjectCard[]> {
  const supabase = getServerSupabase();
  const { data: projects, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error || !projects || projects.length === 0) return [];

  const ids = (projects as Project[]).map((p) => p.id);

  // Batch the related rows so each card can render its journey without N
  // round-trips. We take the latest of each per project in code.
  const [specs, plans, builds, runtimes] = await Promise.all([
    supabase.from('specs').select('*').in('project_id', ids),
    supabase.from('plans').select('*').in('project_id', ids),
    supabase.from('builds').select('*').in('project_id', ids),
    supabase.from('agent_runtimes').select('*').in('project_id', ids),
  ]);

  const latestByProject = <T extends { project_id: string; created_at: string }>(
    rows: T[] | null,
  ): Map<string, T> => {
    const out = new Map<string, T>();
    for (const r of rows ?? []) {
      const cur = out.get(r.project_id);
      if (!cur || new Date(r.created_at) > new Date(cur.created_at)) {
        out.set(r.project_id, r);
      }
    }
    return out;
  };

  const specByProject = latestByProject((specs.data ?? []) as Spec[]);
  const planByProject = latestByProject((plans.data ?? []) as Plan[]);
  const buildByProject = latestByProject((builds.data ?? []) as Build[]);
  const runtimeByProject = latestByProject(
    (runtimes.data ?? []) as AgentRuntime[],
  );

  return (projects as Project[]).map((project) => ({
    project,
    journey: deriveJourney({
      project,
      spec: specByProject.get(project.id) ?? null,
      plan: planByProject.get(project.id) ?? null,
      build: buildByProject.get(project.id) ?? null,
      runtime: runtimeByProject.get(project.id) ?? null,
    }),
  }));
}

export default async function ProjectsPage() {
  const user = await requireUser();
  const cards = await loadProjectCards(user.id);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 py-12">
      <header className="flex items-end justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            archive
          </p>
          <h1 className="mt-2 text-3xl font-medium text-forge-text">
            Forged projects
          </h1>
        </div>
        <Link
          href="/"
          className="rounded-xl border border-white/10 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim hover:border-forge-amber/50 hover:text-forge-amber"
        >
          + new forge
        </Link>
      </header>

      {cards.length === 0 ? (
        <GlassPanel>
          <p className="text-sm text-forge-dim">
            Nothing forged yet. Head to the{' '}
            <Link href="/" className="text-forge-amber hover:underline">
              intake
            </Link>{' '}
            to describe your first agent.
          </p>
        </GlassPanel>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {cards.map(({ project, journey }) => (
            <li key={project.id}>
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
                        {/* Kind badge — surfaced when the project is
                            anything other than a Phase 1 agent, so
                            the archive reads at a glance. */}
                        {project.kind && project.kind !== 'agent' ? (
                          <span
                            className={
                              'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] ' +
                              kindBadgeTone(project.kind)
                            }
                          >
                            {project.kind}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <JourneyStepper journey={journey} layout="compact" />
                  </div>
                </GlassPanel>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Brand-token-aware tint per project kind. Agents wear no badge
// (covered by the journey chip); the rest are visually distinct so a
// long archive of mixed kinds reads at a glance.
function kindBadgeTone(kind: string): string {
  switch (kind) {
    case 'system':
      return 'border-forge-cyan/40 text-forge-cyan';
    case 'software':
      return 'border-emerald-400/40 text-emerald-300';
    case 'infrastructure':
      return 'border-rose-400/40 text-rose-300';
    default:
      return 'border-white/10 text-forge-dim';
  }
}
