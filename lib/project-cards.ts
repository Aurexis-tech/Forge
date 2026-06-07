// Shared project-card loader. Home (all molds) and each mold space load
// the same way; the only difference is an optional mold filter. Server-
// only (queries Supabase) — pages await it.
//
// Each card carries its resolved ProjectMold so the UI can render the
// mold badge and the mold spaces can scope to their own projects without
// a second query.

import { deriveJourney, type Journey } from '@/lib/journey';
import { resolveProjectMold, filterByMold, type ProjectMold } from '@/lib/molds';
import { getServerSupabase } from '@/lib/supabase';
import type { AgentRuntime, Build, Plan, Project, Spec } from '@/lib/types';

export interface ProjectCardData {
  project: Project;
  journey: Journey;
  mold: ProjectMold;
}

/**
 * Load the signed-in user's projects as cards (newest first), each tagged
 * with its resolved mold. Pass `mold` to scope to one mold space; omit it
 * for Home (all projects, including not-yet-classified ones).
 */
export async function loadProjectCards(
  userId: string,
  opts?: { mold?: ProjectMold },
): Promise<ProjectCardData[]> {
  const supabase = getServerSupabase();
  const { data: projects, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error || !projects || projects.length === 0) return [];

  const ids = (projects as Project[]).map((p) => p.id);

  // Batch the related rows so each card renders its journey without N
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

  const cards: ProjectCardData[] = (projects as Project[]).map((project) => {
    const spec = specByProject.get(project.id) ?? null;
    return {
      project,
      journey: deriveJourney({
        project,
        spec,
        plan: planByProject.get(project.id) ?? null,
        build: buildByProject.get(project.id) ?? null,
        runtime: runtimeByProject.get(project.id) ?? null,
      }),
      mold: resolveProjectMold(project, spec),
    };
  });

  return opts?.mold ? filterByMold(cards, opts.mold) : cards;
}

/** Aggregate stats for the dashboard stat row — all REAL: this calendar
 *  month's spend (sum of the user's cost_events) and the total number of
 *  builds across the user's projects. */
export interface DashboardStats {
  monthlySpendUsd: number;
  totalBuilds: number;
}

export async function loadDashboardStats(
  userId: string,
  projectIds: string[],
): Promise<DashboardStats> {
  const supabase = getServerSupabase();
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();

  // Spend this month — cost_events carries user_id + amount_usd (numeric,
  // which PostgREST serializes as a string, so coerce with Number()).
  const { data: spendRows } = await supabase
    .from('cost_events')
    .select('amount_usd')
    .eq('user_id', userId)
    .gte('created_at', monthStart)
    .limit(10000);
  const monthlySpendUsd = (spendRows ?? []).reduce(
    (sum, r) =>
      sum + Number((r as { amount_usd: number | string | null }).amount_usd ?? 0),
    0,
  );

  // Total builds across the user's projects (head count — fetches no rows).
  let totalBuilds = 0;
  if (projectIds.length > 0) {
    const { count } = await supabase
      .from('builds')
      .select('id', { count: 'exact', head: true })
      .in('project_id', projectIds);
    totalBuilds = count ?? 0;
  }

  return { monthlySpendUsd, totalBuilds };
}
