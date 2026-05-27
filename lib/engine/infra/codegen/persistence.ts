// DB helpers for the Phase 4 (Infrastructure) IaC codegen pipeline.
// Same shape as lib/engine/software/codegen/persistence.ts; all four
// codegen pipelines write into the SAME builds + build_files tables,
// distinguished by the `kind` column (extended in 0023 to include
// 'infrastructure').
//
// IMPORTANT: an infrastructure build STOPS after codegen. There's no
// preview / cost-estimate / provision / apply / runtime path for
// kind='infrastructure' in this prompt. The Phase 1 + 2 + 3 codegen
// loaders refuse non-(agent|system|software) kinds with 409 as
// defence in depth, and the loader below refuses anything that isn't
// a confirmed infrastructure spec + approved infra plan.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildLogs,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { InfraSpecSchema, type InfraSpec } from '../spec';
import {
  ProvisioningPlanSchema,
  type ProvisioningPlan,
} from '../planner/schema';
import type { InfraCodegenSummary } from './generate';

export interface ApprovedInfraBuildContext {
  project: Project;
  spec: Spec;
  plan: Plan;
  parsedSpec: InfraSpec;
  parsedPlan: ProvisioningPlan;
}

// Mirror of the agent + system + software codegen loaders. Walks the
// (project → latest spec → latest infra plan) chain and refuses any
// misroute with a clear 409. Both ends MUST be kind='infrastructure'.
export async function loadApprovedInfraPlanForCodegen(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<
  ApprovedInfraBuildContext | { error: string; status: number }
> {
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
      error:
        "spec is in status '" +
        spec.status +
        "'; must be 'confirmed' before infra codegen",
      status: 409,
    };
  }
  if (spec.kind === 'agent') {
    return {
      error:
        "this project's spec is an AgentSpec (Phase 1). Use /api/projects/[id]/build/generate for agent codegen.",
      status: 409,
    };
  }
  if (spec.kind === 'system') {
    return {
      error:
        "this project's spec is a SystemSpec (Phase 2). Use /api/projects/[id]/system/build/generate for system codegen.",
      status: 409,
    };
  }
  if (spec.kind === 'software') {
    return {
      error:
        "this project's spec is a SoftwareSpec (Phase 3). Use /api/projects/[id]/software/build/generate for software codegen.",
      status: 409,
    };
  }
  if (spec.kind !== 'infrastructure') {
    return {
      error: "unsupported spec kind '" + spec.kind + "'",
      status: 409,
    };
  }

  // Latest kind='infrastructure' plan in status='approved'.
  const { data: plans, error: planErr } = await supabase
    .from('plans')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'infrastructure')
    .order('created_at', { ascending: false })
    .limit(1);
  if (planErr) return { error: planErr.message, status: 500 };

  const plan = (plans?.[0] as Plan | undefined) ?? null;
  if (!plan) {
    return { error: 'project has no infrastructure plan', status: 409 };
  }
  if (plan.status !== 'approved') {
    return {
      error:
        "infrastructure plan is in status '" +
        plan.status +
        "'; must be 'approved' before codegen",
      status: 409,
    };
  }

  const parsedSpec = InfraSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return {
      error: 'stored InfraSpec no longer matches the current schema',
      status: 422,
    };
  }
  const parsedPlan = ProvisioningPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return {
      error:
        'stored ProvisioningPlan no longer matches the current schema',
      status: 422,
    };
  }

  return {
    project: project as Project,
    spec,
    plan,
    parsedSpec: parsedSpec.data,
    parsedPlan: parsedPlan.data,
  };
}

// Latest infra build row scoped to kind='infrastructure'. Defensive
// scoping — a project only has one kind of build but the filter keeps
// cross-kind rows from leaking.
export async function loadLatestInfraBuild(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Build | null> {
  const { data, error } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'infrastructure')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Build | null) ?? null;
}

export async function ensureInfraCodegenBuild(
  supabase: ForgeSupabase,
  projectId: string,
  planId: string,
  specId: string,
): Promise<{ build: Build } | { error: string; status: number }> {
  const existing = await loadLatestInfraBuild(supabase, projectId);
  if (existing && existing.plan_id === planId) {
    if (existing.status === 'generated') {
      return {
        error:
          "latest infrastructure build is in status 'generated'; the gates downstream of generate (preview / provision / apply) are not implemented yet in this phase",
        status: 409,
      };
    }
    if (
      existing.status === 'queued' ||
      existing.status === 'generating' ||
      existing.status === 'failed'
    ) {
      return { build: existing };
    }
  }
  return {
    build: await insertInfraCodegenBuild(supabase, projectId, planId, specId),
  };
}

export async function insertInfraCodegenBuild(
  supabase: ForgeSupabase,
  projectId: string,
  planId: string,
  specId: string,
): Promise<Build> {
  const { data, error } = await supabase
    .from('builds')
    .insert({
      project_id: projectId,
      plan_id: planId,
      spec_id: specId,
      kind: 'infrastructure',
      phase: 'codegen',
      status: 'queued',
      logs: [] as unknown as Build['logs'],
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert infrastructure build');
  }
  return data as Build;
}

export async function markInfraBuildGenerating(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'generating' })
    .eq('id', buildId);
}

export async function markInfraBuildFailed(
  supabase: ForgeSupabase,
  buildId: string,
  projectId: string,
  message: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'failed' })
    .eq('id', buildId);
  await supabase.from('audit_log').insert({
    project_id: projectId,
    action: 'infra.codegen_failed',
    actor: 'engine.infra.codegen',
    detail: { build_id: buildId, message },
  });
}

export async function storeInfraBuildFiles(
  supabase: ForgeSupabase,
  buildId: string,
  summary: InfraCodegenSummary,
): Promise<void> {
  // Clear any stale rows so the (build_id, path) unique constraint
  // doesn't conflict on retries.
  const { error: delErr } = await supabase
    .from('build_files')
    .delete()
    .eq('build_id', buildId);
  if (delErr) throw delErr;

  if (summary.files.length === 0) return;

  const rows = summary.files.map((f) => ({
    build_id: buildId,
    path: f.path,
    content: f.content,
    source: f.source,
    bytes: f.bytes,
  }));

  const { error } = await supabase.from('build_files').insert(rows);
  if (error) throw error;
}

export async function completeInfraCodegen(
  supabase: ForgeSupabase,
  build: Build,
  summary: InfraCodegenSummary,
): Promise<void> {
  const logs: BuildLogs = {
    static_checks: summary.static_checks.map((c) => ({
      path: c.path,
      status: c.status,
      ...(c.error ? { error: c.error } : {}),
    })),
    warnings: [],
    // Aggregate secure-default flags + structural pass/fail land in
    // the build's logs blob so the UI can render the SECURE-DEFAULTS
    // strip without re-running the validator. Extra keys on BuildLogs
    // are tolerated by the existing JSON shape.
    infra_secure_defaults: summary.secure_defaults,
    infra_structural_ok: summary.structural_ok,
    infra_public_opt_ins: [...summary.public_exposure_opt_ins],
    infra_module_ids_used: [...summary.module_ids_used],
  } as unknown as BuildLogs;

  const { error } = await supabase
    .from('builds')
    .update({
      status: summary.structural_ok ? 'generated' : 'failed',
      logs: logs as unknown as Build['logs'],
    })
    .eq('id', build.id);
  if (error) throw error;

  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: summary.structural_ok
      ? 'infra.codegen_completed'
      : 'infra.codegen_failed',
    actor: 'engine.infra.codegen',
    detail: {
      build_id: build.id,
      files_total: summary.files.length,
      files_by_layer: summary.files_by_layer,
      module_ids_used: [...summary.module_ids_used],
      // Public-exposure opt-ins flagged so a future P4-5 confirm gate
      // can surface them.
      public_exposure_opt_ins: [...summary.public_exposure_opt_ins],
      secure_defaults: summary.secure_defaults,
      steps_composed: summary.steps_composed.length,
      structural_ok: summary.structural_ok,
      // Belt-and-braces marker: this codegen NEVER calls a cloud API
      // or runs terraform plan/apply. Captured in audit so a reviewer
      // can verify the boundary held.
      cloud_calls: 0,
      terraform_plan_invoked: false,
      terraform_apply_invoked: false,
    },
  });
}

export async function logInfraCodegenStarted(
  supabase: ForgeSupabase,
  build: Build,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.codegen_started',
    actor: 'engine.infra.codegen',
    detail: { build_id: build.id },
  });
}
