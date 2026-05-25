// DB helpers for the planner. Server-only (Supabase + LLM modules each guard
// against browser imports, so this file is safe by transitive defense).

import type { LLMUsage } from '../llm';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Plan, PlanFeedback, Project, Spec } from '@/lib/types';
import {
  AgentSpecSchema,
  type AgentSpec,
} from '../spec/schema';
import { BuildPlanSchema, type BuildPlan } from './schema';
import { summariseToolCoverage } from './plan';

export interface ProjectAndConfirmedSpec {
  project: Project;
  spec: Spec;
  parsedSpec: AgentSpec;
}

export async function loadProjectWithConfirmedSpec(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<ProjectAndConfirmedSpec | { error: string; status: number }> {
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
      error: `spec is in status '${spec.status}'; must be 'confirmed' before planning`,
      status: 409,
    };
  }
  // Phase 2 defence-in-depth: the planner only knows how to build a
  // single AgentSpec. A SystemSpec confirms but stops here — the build
  // pipeline for systems lands in a later phase. The UI already hides
  // the Plan/Build/Push/Deploy/Runtime panels for kind='system', so
  // this is a backstop for direct API callers.
  if (spec.kind === 'system') {
    return {
      error:
        "this project's spec is a SystemSpec (Phase 2). Systems are review-only in this phase — code generation is not implemented yet.",
      status: 409,
    };
  }

  const parsed = AgentSpecSchema.safeParse(spec.structured_spec);
  if (!parsed.success) {
    return {
      error: 'stored AgentSpec no longer matches the current schema',
      status: 422,
    };
  }

  return { project: project as Project, spec, parsedSpec: parsed.data };
}

export async function loadLatestPlan(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Plan | null> {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Plan | null) ?? null;
}

// Reuse the latest plan row when it's safe (pending / failed / awaiting_review),
// otherwise create a fresh one. We deliberately overwrite awaiting_review on
// regenerate so the user sees a single, current plan rather than a stack.
export async function ensurePlanRow(
  supabase: ForgeSupabase,
  projectId: string,
  specId: string,
): Promise<Plan> {
  const existing = await loadLatestPlan(supabase, projectId);
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
      status: 'pending',
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to create plan row');
  }
  return data as Plan;
}

export async function markPlanPlanning(
  supabase: ForgeSupabase,
  planId: string,
): Promise<void> {
  await supabase.from('plans').update({ status: 'planning' }).eq('id', planId);
}

interface PersistPlanArgs {
  supabase: ForgeSupabase;
  planId: string;
  projectId: string;
  plan: BuildPlan;
  usage: LLMUsage;
  model: string;
  attempts: number;
  feedback: PlanFeedback | null;
  source: 'generate' | 'refine';
}

export async function persistPlanResult(
  args: PersistPlanArgs,
): Promise<{ status: 'awaiting_review' }> {
  const { error } = await args.supabase
    .from('plans')
    .update({
      plan: args.plan as unknown as Plan['plan'],
      feedback: (args.feedback ?? null) as unknown as Plan['feedback'],
      status: 'awaiting_review',
    })
    .eq('id', args.planId);
  if (error) throw error;

  await args.supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'plan.generated',
    actor: 'engine.planner',
    detail: {
      source: args.source,
      attempts: args.attempts,
      model: args.model,
      usage: args.usage,
      tool_coverage: summariseToolCoverage(args.plan),
      warnings_count: args.plan.warnings.length,
      tasks_count: args.plan.tasks.length,
    },
  });

  return { status: 'awaiting_review' };
}

export async function markPlanFailed(
  supabase: ForgeSupabase,
  planId: string,
  projectId: string,
  message: string,
): Promise<void> {
  await supabase.from('plans').update({ status: 'failed' }).eq('id', planId);
  await supabase.from('audit_log').insert({
    project_id: projectId,
    action: 'plan.failed',
    actor: 'engine.planner',
    detail: { message },
  });
}

export async function approvePlan(
  supabase: ForgeSupabase,
  planRow: Plan,
): Promise<BuildPlan> {
  // Re-validate at the gate so a schema bump doesn't silently lock a stale plan.
  const parsed = BuildPlanSchema.safeParse(planRow.plan);
  if (!parsed.success) {
    throw new Error('stored plan no longer matches the current schema');
  }
  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'approved' })
    .eq('id', planRow.id);
  if (planErr) throw planErr;

  const { error: projErr } = await supabase
    .from('projects')
    .update({ status: 'plan_approved' })
    .eq('id', planRow.project_id);
  if (projErr) throw projErr;

  await supabase.from('audit_log').insert({
    project_id: planRow.project_id,
    action: 'plan.approved',
    actor: 'user',
    detail: { plan_id: planRow.id },
  });

  return parsed.data;
}

export function mergePlanFeedback(
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
