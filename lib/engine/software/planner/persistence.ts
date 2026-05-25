// DB helpers for the Phase 3 software planner. Same shape as
// lib/engine/system/planner/persistence.ts; all three planners write
// into the SAME `plans` table distinguished by the `kind` column
// (extended in supabase/migrations/0015_software_plans.sql to include
// 'software').

import type { LLMUsage } from '@/lib/engine/llm';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Plan, PlanFeedback, Project, Spec } from '@/lib/types';
import { SoftwareSpecSchema, type SoftwareSpec } from '../spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from './schema';
import { summariseSoftwareBuildPlan } from './plan';

export interface ProjectAndConfirmedSoftwareSpec {
  project: Project;
  spec: Spec;
  parsedSpec: SoftwareSpec;
}

// Mirror of the agent + system planners' "load confirmed spec" guard.
// Rejects misroutes with a clear 409 so a /software/plan/* route can't
// be pointed at an agent or system project by mistake.
export async function loadProjectWithConfirmedSoftwareSpec(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<ProjectAndConfirmedSoftwareSpec | { error: string; status: number }> {
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projErr || !project) return { error: 'project not found', status: 404 };

  const { data: specs, error: specErr } = await supabase
    .from('specs')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (specErr) return { error: specErr.message, status: 500 };

  const spec = (specs?.[0] as Spec | undefined) ?? null;
  if (!spec) return { error: 'project has no spec', status: 409 };
  if (spec.status !== 'confirmed') {
    return {
      error: "spec is in status '" + spec.status + "'; must be 'confirmed' before planning",
      status: 409,
    };
  }
  if (spec.kind === 'agent') {
    return {
      error:
        "this project's spec is an AgentSpec (Phase 1). Use /api/projects/[id]/plan for agent plans.",
      status: 409,
    };
  }
  if (spec.kind === 'system') {
    return {
      error:
        "this project's spec is a SystemSpec (Phase 2). Use /api/projects/[id]/system/plan for system plans.",
      status: 409,
    };
  }
  if (spec.kind === 'infrastructure') {
    return {
      error:
        "this project's spec is an InfraSpec (Phase 4). Infrastructure is review-only in this phase — provisioning is not implemented yet.",
      status: 409,
    };
  }
  if (spec.kind !== 'software') {
    return {
      error: "unsupported spec kind '" + spec.kind + "'",
      status: 409,
    };
  }

  const parsed = SoftwareSpecSchema.safeParse(spec.structured_spec);
  if (!parsed.success) {
    return {
      error: 'stored SoftwareSpec no longer matches the current schema',
      status: 422,
    };
  }

  return { project: project as Project, spec, parsedSpec: parsed.data };
}

// Latest plan row scoped to kind='software'.
export async function loadLatestSoftwarePlan(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Plan | null> {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'software')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Plan | null) ?? null;
}

export async function ensureSoftwarePlanRow(
  supabase: ForgeSupabase,
  projectId: string,
  specId: string,
): Promise<Plan> {
  const existing = await loadLatestSoftwarePlan(supabase, projectId);
  if (
    existing &&
    existing.spec_id === specId &&
    (existing.status === 'pending' ||
      existing.status === 'failed' ||
      existing.status === 'awaiting_review' ||
      existing.status === 'planning')
  ) {
    return existing;
  }
  const { data, error } = await supabase
    .from('plans')
    .insert({
      project_id: projectId,
      spec_id: specId,
      kind: 'software',
      status: 'pending',
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to create software plan row');
  }
  return data as Plan;
}

export async function markSoftwarePlanPlanning(
  supabase: ForgeSupabase,
  planId: string,
): Promise<void> {
  await supabase.from('plans').update({ status: 'planning' }).eq('id', planId);
}

interface PersistSoftwarePlanArgs {
  supabase: ForgeSupabase;
  planId: string;
  projectId: string;
  plan: SoftwareBuildPlan;
  usage: LLMUsage;
  model: string;
  attempts: number;
  feedback: PlanFeedback | null;
  source: 'generate' | 'refine';
}

export async function persistSoftwarePlanResult(
  args: PersistSoftwarePlanArgs,
): Promise<{ status: 'awaiting_review' }> {
  const { error } = await args.supabase
    .from('plans')
    .update({
      plan: args.plan as unknown as Plan['plan'],
      feedback: (args.feedback ?? null) as unknown as Plan['feedback'],
      kind: 'software',
      status: 'awaiting_review',
    })
    .eq('id', args.planId);
  if (error) throw error;

  await args.supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'software.plan_generated',
    actor: 'engine.software.planner',
    detail: {
      source: args.source,
      attempts: args.attempts,
      model: args.model,
      usage: args.usage,
      ...summariseSoftwareBuildPlan(args.plan),
    },
  });

  return { status: 'awaiting_review' };
}

export async function markSoftwarePlanFailed(
  supabase: ForgeSupabase,
  planId: string,
  projectId: string,
  message: string,
): Promise<void> {
  await supabase.from('plans').update({ status: 'failed' }).eq('id', planId);
  await supabase.from('audit_log').insert({
    project_id: projectId,
    action: 'software.plan_failed',
    actor: 'engine.software.planner',
    detail: { message },
  });
}

export async function approveSoftwarePlan(
  supabase: ForgeSupabase,
  planRow: Plan,
): Promise<SoftwareBuildPlan> {
  const parsed = SoftwareBuildPlanSchema.safeParse(planRow.plan);
  if (!parsed.success) {
    throw new Error('stored SoftwareBuildPlan no longer matches the current schema');
  }
  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'approved' })
    .eq('id', planRow.id);
  if (planErr) throw planErr;

  // Bump the project status so the page header reflects "plan
  // approved". Generation / sandbox / deploy / runtime stay closed
  // for kind='software' — both planner loaders 409 anything past this.
  const { error: projErr } = await supabase
    .from('projects')
    .update({ status: 'plan_approved' })
    .eq('id', planRow.project_id);
  if (projErr) throw projErr;

  await supabase.from('audit_log').insert({
    project_id: planRow.project_id,
    action: 'software.plan_approved',
    actor: 'user',
    detail: {
      plan_id: planRow.id,
      ...summariseSoftwareBuildPlan(parsed.data),
    },
  });

  return parsed.data;
}

export function mergeSoftwarePlanFeedback(
  existing: PlanFeedback | null | undefined,
  incoming: PlanFeedback,
): PlanFeedback {
  return {
    refinements: [
      ...(existing?.refinements ?? []),
      ...(incoming.refinements ?? []),
    ],
  };
}
