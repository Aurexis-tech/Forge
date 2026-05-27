// DB helpers for the Phase 2 (Systems) codegen pipeline. Same shape as
// lib/engine/codegen/persistence.ts; both modules write into the SAME
// `builds` + `build_files` tables, distinguished by the `kind` column
// (extended in supabase/migrations/0018_system_builds.sql to include
// 'system').
//
// IMPORTANT: a system build STOPS after codegen. There's no sandbox
// test, deploy, or runtime path for kind='system' in this prompt. The
// Phase 1 codegen loader (`loadApprovedPlanForCodegen`) refuses non-
// agent kinds with 409 as defence in depth, and the loader below
// refuses anything that isn't a confirmed-system spec + approved-
// system plan.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildLogs,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { SystemSpecSchema, type SystemSpec } from '../spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '../planner/schema';
import type { SystemCodegenSummary } from './generate';

export interface ApprovedSystemBuildContext {
  project: Project;
  spec: Spec;
  plan: Plan;
  parsedSpec: SystemSpec;
  parsedPlan: OrchestrationPlan;
}

// Mirror of the Phase 1 + system + software planner loaders. Walks the
// (project → latest spec → latest plan) chain and refuses any misroute
// with a clear 409. Both ends of the chain must be 'system' OR the
// system codegen pipeline refuses to start.
export async function loadApprovedSystemPlanForCodegen(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<
  ApprovedSystemBuildContext | { error: string; status: number }
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
        "'; must be 'confirmed' before codegen",
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
  if (spec.kind === 'software') {
    return {
      error:
        "this project's spec is a SoftwareSpec (Phase 3). Use /api/projects/[id]/software/build/generate for software codegen.",
      status: 409,
    };
  }
  if (spec.kind === 'infrastructure') {
    return {
      error:
        "this project's spec is an InfraSpec (Phase 4). Use /api/projects/[id]/infra/build/generate for infrastructure IaC codegen.",
      status: 409,
    };
  }
  if (spec.kind !== 'system') {
    return {
      error: "unsupported spec kind '" + spec.kind + "'",
      status: 409,
    };
  }

  // The plan must be the LATEST kind='system' plan, in status='approved'.
  // Scoping to kind='system' here ensures a stray cross-kind plan row
  // can't slip into codegen.
  const { data: plans, error: planErr } = await supabase
    .from('plans')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'system')
    .order('created_at', { ascending: false })
    .limit(1);
  if (planErr) return { error: planErr.message, status: 500 };

  const plan = (plans?.[0] as Plan | undefined) ?? null;
  if (!plan) return { error: 'project has no system plan', status: 409 };
  if (plan.status !== 'approved') {
    return {
      error:
        "system plan is in status '" +
        plan.status +
        "'; must be 'approved' before codegen",
      status: 409,
    };
  }

  const parsedSpec = SystemSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return {
      error: 'stored SystemSpec no longer matches the current schema',
      status: 422,
    };
  }
  const parsedPlan = OrchestrationPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return {
      error: 'stored OrchestrationPlan no longer matches the current schema',
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

// Latest system build row scoped to kind='system'. Phase 1's
// loadLatestBuild scans the unfiltered builds table; this helper keeps
// system codegen honest about the discriminator even when both kinds
// of build row could exist for the same project (impossible by current
// code paths, but cheap to be defensive about).
export async function loadLatestSystemBuild(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Build | null> {
  const { data, error } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'system')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Build | null) ?? null;
}

export async function ensureSystemCodegenBuild(
  supabase: ForgeSupabase,
  projectId: string,
  planId: string,
  specId: string,
): Promise<
  | { build: Build }
  | { error: string; status: number }
> {
  const existing = await loadLatestSystemBuild(supabase, projectId);
  if (existing && existing.plan_id === planId) {
    if (
      existing.status === 'generated' ||
      existing.status === 'running' ||
      existing.status === 'success'
    ) {
      return {
        error:
          "latest system build is in status '" +
          existing.status +
          "'; use regenerate to create a fresh build",
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
  return { build: await insertSystemCodegenBuild(supabase, projectId, planId, specId) };
}

export async function insertSystemCodegenBuild(
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
      kind: 'system',
      phase: 'codegen',
      status: 'queued',
      logs: [] as unknown as Build['logs'],
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('failed to insert system build');
  return data as Build;
}

export async function markSystemBuildGenerating(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'generating' })
    .eq('id', buildId);
}

export async function markSystemBuildFailed(
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
    action: 'system.codegen_failed',
    actor: 'engine.system.codegen',
    detail: { build_id: buildId, message },
  });
}

export async function storeSystemBuildFiles(
  supabase: ForgeSupabase,
  buildId: string,
  summary: SystemCodegenSummary,
): Promise<void> {
  // Clear any stale rows from a previous attempt on the same build_id
  // so the (build_id, path) unique constraint doesn't conflict on
  // retries.
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

export async function completeSystemCodegen(
  supabase: ForgeSupabase,
  build: Build,
  summary: SystemCodegenSummary,
): Promise<void> {
  const logs: BuildLogs = {
    static_checks: summary.files.map((f) => ({
      path: f.path,
      status: f.staticCheck.ok ? 'ok' : 'failed',
      ...(f.staticCheck.ok ? {} : { error: f.staticCheck.error }),
    })),
    warnings: summary.warnings,
  };

  const { error } = await supabase
    .from('builds')
    .update({
      status: 'generated',
      logs: logs as unknown as Build['logs'],
    })
    .eq('id', build.id);
  if (error) throw error;

  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.codegen_completed',
    actor: 'engine.system.codegen',
    detail: {
      build_id: build.id,
      files_total: summary.files.length,
      modules_total: summary.modulesGenerated,
      modules_failed: summary.modulesFailed,
      orchestrator_path: summary.orchestratorPath,
      entrypoint_path: summary.entrypointPath,
      scaffold_count: summary.files.filter((f) => f.source === 'scaffold').length,
      generated_count: summary.files.filter((f) => f.source === 'generated').length,
      usage: summary.usage,
      attempts: summary.attempts,
      models: summary.modelsUsed,
      scaffold_id: summary.scaffoldId,
      warnings_count: summary.warnings.length,
    },
  });
}

export async function logSystemCodegenStarted(
  supabase: ForgeSupabase,
  build: Build,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'system.codegen_started',
    actor: 'engine.system.codegen',
    detail: { build_id: build.id, plan_id: build.plan_id },
  });
}
