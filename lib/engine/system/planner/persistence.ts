// DB helpers for the Phase 2 orchestration planner. Same shape as
// lib/engine/planner/persistence.ts; both modules write into the SAME
// `plans` table distinguished by the `kind` discriminator added in
// supabase/migrations/0013_system_plans.sql.

import type { LLMUsage } from '@/lib/engine/llm';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Plan, PlanFeedback, Project, Spec } from '@/lib/types';
import { SystemSpecSchema, type SystemSpec } from '../spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from './schema';
import { summariseOrchestrationPlan } from './plan';

export interface ProjectAndConfirmedSystemSpec {
  project: Project;
  spec: Spec;
  parsedSpec: SystemSpec;
}

// Mirror of the agent planner's loadProjectWithConfirmedSpec — same
// fail-shape, but validates the confirmed spec against the SystemSpec
// schema and rejects 'agent' kinds so the system planner can't be
// pointed at an AgentSpec by mistake.
export async function loadProjectWithConfirmedSystemSpec(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<ProjectAndConfirmedSystemSpec | { error: string; status: number }> {
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
  if (spec.kind !== 'system') {
    return {
      error:
        "this project's spec is an AgentSpec (Phase 1). Use /api/projects/[id]/plan for agent plans.",
      status: 409,
    };
  }

  const parsed = SystemSpecSchema.safeParse(spec.structured_spec);
  if (!parsed.success) {
    return {
      error: 'stored SystemSpec no longer matches the current schema',
      status: 422,
    };
  }

  return { project: project as Project, spec, parsedSpec: parsed.data };
}

// Latest plan row scoped to kind='system'. Phase 1's loadLatestPlan
// stays unchanged; the system path uses this explicitly so a stray
// agent plan row (impossible by current code paths, but cheap to be
// defensive about) can't slip into the system flow.
export async function loadLatestSystemPlan(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Plan | null> {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'system')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Plan | null) ?? null;
}

// Reuse the latest plan row when it's safe (pending / failed /
// awaiting_review / planning), otherwise insert a fresh one. Matches
// the Phase 1 planner's ensurePlanRow semantics; the only difference
// is that we set kind='system' on insert so the discriminator stays
// honest.
export async function ensureSystemPlanRow(
  supabase: ForgeSupabase,
  projectId: string,
  specId: string,
): Promise<Plan> {
  const existing = await loadLatestSystemPlan(supabase, projectId);
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
      kind: 'system',
      status: 'pending',
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to create system plan row');
  }
  return data as Plan;
}

export async function markSystemPlanPlanning(
  supabase: ForgeSupabase,
  planId: string,
): Promise<void> {
  await supabase.from('plans').update({ status: 'planning' }).eq('id', planId);
}

interface PersistSystemPlanArgs {
  supabase: ForgeSupabase;
  planId: string;
  projectId: string;
  plan: OrchestrationPlan;
  usage: LLMUsage;
  model: string;
  attempts: number;
  feedback: PlanFeedback | null;
  source: 'generate' | 'refine';
}

export async function persistSystemPlanResult(
  args: PersistSystemPlanArgs,
): Promise<{ status: 'awaiting_review' }> {
  const { error } = await args.supabase
    .from('plans')
    .update({
      plan: args.plan as unknown as Plan['plan'],
      feedback: (args.feedback ?? null) as unknown as Plan['feedback'],
      kind: 'system',
      status: 'awaiting_review',
    })
    .eq('id', args.planId);
  if (error) throw error;

  await args.supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'system.plan_generated',
    actor: 'engine.system.planner',
    detail: {
      source: args.source,
      attempts: args.attempts,
      model: args.model,
      usage: args.usage,
      ...summariseOrchestrationPlan(args.plan),
    },
  });

  return { status: 'awaiting_review' };
}

export async function markSystemPlanFailed(
  supabase: ForgeSupabase,
  planId: string,
  projectId: string,
  message: string,
): Promise<void> {
  await supabase.from('plans').update({ status: 'failed' }).eq('id', planId);
  await supabase.from('audit_log').insert({
    project_id: projectId,
    action: 'system.plan_failed',
    actor: 'engine.system.planner',
    detail: { message },
  });
}

export async function approveSystemPlan(
  supabase: ForgeSupabase,
  planRow: Plan,
): Promise<OrchestrationPlan> {
  const parsed = OrchestrationPlanSchema.safeParse(planRow.plan);
  if (!parsed.success) {
    throw new Error('stored OrchestrationPlan no longer matches the current schema');
  }
  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'approved' })
    .eq('id', planRow.id);
  if (planErr) throw planErr;

  // Mirror the Phase 1 approve: bump the project status so the page
  // header reflects "plan approved". Build / deploy / runtime stay
  // gated behind kind==='system' in the UI + the planner's defence-in-
  // depth guards.
  const { error: projErr } = await supabase
    .from('projects')
    .update({ status: 'plan_approved' })
    .eq('id', planRow.project_id);
  if (projErr) throw projErr;

  await supabase.from('audit_log').insert({
    project_id: planRow.project_id,
    action: 'system.plan_approved',
    actor: 'user',
    detail: {
      plan_id: planRow.id,
      ...summariseOrchestrationPlan(parsed.data),
    },
  });

  return parsed.data;
}

export function mergeSystemPlanFeedback(
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
