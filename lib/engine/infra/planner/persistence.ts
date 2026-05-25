// DB helpers for the Phase 4 infrastructure planner. Same shape as
// lib/engine/software/planner/persistence.ts; all four planners write
// into the SAME `plans` table distinguished by the `kind` column
// (extended in supabase/migrations/0017_infra_plans.sql to include
// 'infrastructure').
//
// IMPORTANT: infrastructure stays gated AFTER approval. There's no
// generation, preview, or provisioning pipeline yet for kind=
// 'infrastructure'. The agent / system / software planners' loaders
// all 409 a confirmed infrastructure spec (defence in depth, see
// 0016_infrastructure migration commit), and this loader 409s anything
// that isn't an InfraSpec — so a stray /infra/plan call against an
// agent/system/software project can't slip through.

import type { LLMUsage } from '@/lib/engine/llm';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Plan, PlanFeedback, Project, Spec } from '@/lib/types';
import { InfraSpecSchema, type InfraSpec } from '../spec';
import {
  ProvisioningPlanSchema,
  type ProvisioningPlan,
} from './schema';
import { summariseProvisioningPlan } from './plan';

export interface ProjectAndConfirmedInfraSpec {
  project: Project;
  spec: Spec;
  parsedSpec: InfraSpec;
}

// Mirror of the agent + system + software planners' "load confirmed
// spec" guard. Rejects misroutes with a clear 409 so a
// /infra/plan/* route can't be pointed at an agent / system /
// software project by mistake.
export async function loadProjectWithConfirmedInfraSpec(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<ProjectAndConfirmedInfraSpec | { error: string; status: number }> {
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
  if (spec.kind === 'software') {
    return {
      error:
        "this project's spec is a SoftwareSpec (Phase 3). Use /api/projects/[id]/software/plan for software plans.",
      status: 409,
    };
  }
  if (spec.kind !== 'infrastructure') {
    return {
      error: "unsupported spec kind '" + spec.kind + "'",
      status: 409,
    };
  }

  const parsed = InfraSpecSchema.safeParse(spec.structured_spec);
  if (!parsed.success) {
    return {
      error: 'stored InfraSpec no longer matches the current schema',
      status: 422,
    };
  }

  return { project: project as Project, spec, parsedSpec: parsed.data };
}

// Latest plan row scoped to kind='infrastructure'.
export async function loadLatestInfraPlan(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Plan | null> {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'infrastructure')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Plan | null) ?? null;
}

export async function ensureInfraPlanRow(
  supabase: ForgeSupabase,
  projectId: string,
  specId: string,
): Promise<Plan> {
  const existing = await loadLatestInfraPlan(supabase, projectId);
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
      kind: 'infrastructure',
      status: 'pending',
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to create infrastructure plan row');
  }
  return data as Plan;
}

export async function markInfraPlanPlanning(
  supabase: ForgeSupabase,
  planId: string,
): Promise<void> {
  await supabase.from('plans').update({ status: 'planning' }).eq('id', planId);
}

interface PersistInfraPlanArgs {
  supabase: ForgeSupabase;
  planId: string;
  projectId: string;
  plan: ProvisioningPlan;
  usage: LLMUsage;
  model: string;
  attempts: number;
  feedback: PlanFeedback | null;
  source: 'generate' | 'refine';
}

export async function persistInfraPlanResult(
  args: PersistInfraPlanArgs,
): Promise<{ status: 'awaiting_review' }> {
  const { error } = await args.supabase
    .from('plans')
    .update({
      plan: args.plan as unknown as Plan['plan'],
      feedback: (args.feedback ?? null) as unknown as Plan['feedback'],
      kind: 'infrastructure',
      status: 'awaiting_review',
    })
    .eq('id', args.planId);
  if (error) throw error;

  await args.supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'infra.plan_generated',
    actor: 'engine.infra.planner',
    detail: {
      source: args.source,
      attempts: args.attempts,
      model: args.model,
      usage: args.usage,
      ...summariseProvisioningPlan(args.plan),
    },
  });

  return { status: 'awaiting_review' };
}

export async function markInfraPlanFailed(
  supabase: ForgeSupabase,
  planId: string,
  projectId: string,
  message: string,
): Promise<void> {
  await supabase.from('plans').update({ status: 'failed' }).eq('id', planId);
  await supabase.from('audit_log').insert({
    project_id: projectId,
    action: 'infra.plan_failed',
    actor: 'engine.infra.planner',
    detail: { message },
  });
}

export async function approveInfraPlan(
  supabase: ForgeSupabase,
  planRow: Plan,
): Promise<ProvisioningPlan> {
  const parsed = ProvisioningPlanSchema.safeParse(planRow.plan);
  if (!parsed.success) {
    throw new Error('stored ProvisioningPlan no longer matches the current schema');
  }
  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'approved' })
    .eq('id', planRow.id);
  if (planErr) throw planErr;

  // Bump the project status so the page header reflects "plan
  // approved". Generation / preview / provisioning stay CLOSED for
  // kind='infrastructure' — the agent / system / software planner
  // loaders all 409 a confirmed infrastructure spec (defence in depth).
  const { error: projErr } = await supabase
    .from('projects')
    .update({ status: 'plan_approved' })
    .eq('id', planRow.project_id);
  if (projErr) throw projErr;

  await supabase.from('audit_log').insert({
    project_id: planRow.project_id,
    action: 'infra.plan_approved',
    actor: 'user',
    detail: {
      plan_id: planRow.id,
      ...summariseProvisioningPlan(parsed.data),
    },
  });

  return parsed.data;
}

export function mergeInfraPlanFeedback(
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
