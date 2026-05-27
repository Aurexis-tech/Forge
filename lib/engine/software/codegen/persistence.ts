// DB helpers for the Phase 3 (Software) codegen pipeline. Same shape
// as lib/engine/system/codegen/persistence.ts; all three codegen
// pipelines write into the SAME builds + build_files tables,
// distinguished by the `kind` column (extended in 0020 to include
// 'software').
//
// IMPORTANT: a software build STOPS after codegen. There's no app
// sandbox test, DB provisioning + deploy, or runtime path for
// kind='software' in this phase. The Phase 1 + 2 codegen loaders
// refuse non-agent / non-system kinds with 409 as defence in depth,
// and the loader below refuses anything that isn't a confirmed
// software spec + approved software plan.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildLogs,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { SoftwareSpecSchema, type SoftwareSpec } from '../spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '../planner/schema';
import type { SoftwareCodegenSummary } from './generate';

export interface ApprovedSoftwareBuildContext {
  project: Project;
  spec: Spec;
  plan: Plan;
  parsedSpec: SoftwareSpec;
  parsedPlan: SoftwareBuildPlan;
}

// Mirror of the agent + system codegen loaders. Walks the
// (project → latest spec → latest software plan) chain and refuses
// any misroute with a clear 409. Both ends of the chain MUST be
// kind='software' OR the codegen pipeline refuses to start.
export async function loadApprovedSoftwarePlanForCodegen(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<
  ApprovedSoftwareBuildContext | { error: string; status: number }
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
  if (spec.kind === 'system') {
    return {
      error:
        "this project's spec is a SystemSpec (Phase 2). Use /api/projects/[id]/system/build/generate for system codegen.",
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
  if (spec.kind !== 'software') {
    return {
      error: "unsupported spec kind '" + spec.kind + "'",
      status: 409,
    };
  }

  // The plan must be the LATEST kind='software' plan, in
  // status='approved'. Scoping to kind='software' here ensures a
  // stray cross-kind plan row can't slip into codegen.
  const { data: plans, error: planErr } = await supabase
    .from('plans')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'software')
    .order('created_at', { ascending: false })
    .limit(1);
  if (planErr) return { error: planErr.message, status: 500 };

  const plan = (plans?.[0] as Plan | undefined) ?? null;
  if (!plan) return { error: 'project has no software plan', status: 409 };
  if (plan.status !== 'approved') {
    return {
      error:
        "software plan is in status '" +
        plan.status +
        "'; must be 'approved' before codegen",
      status: 409,
    };
  }

  const parsedSpec = SoftwareSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return {
      error: 'stored SoftwareSpec no longer matches the current schema',
      status: 422,
    };
  }
  const parsedPlan = SoftwareBuildPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return {
      error: 'stored SoftwareBuildPlan no longer matches the current schema',
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

// Latest software build row scoped to kind='software'. Defensive
// scoping — a project only ever has one kind of build, but the
// filter keeps cross-kind rows from leaking.
export async function loadLatestSoftwareBuild(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Build | null> {
  const { data, error } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'software')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Build | null) ?? null;
}

export async function ensureSoftwareCodegenBuild(
  supabase: ForgeSupabase,
  projectId: string,
  planId: string,
  specId: string,
): Promise<{ build: Build } | { error: string; status: number }> {
  const existing = await loadLatestSoftwareBuild(supabase, projectId);
  if (existing && existing.plan_id === planId) {
    if (
      existing.status === 'generated' ||
      existing.status === 'running' ||
      existing.status === 'success'
    ) {
      return {
        error:
          "latest software build is in status '" +
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
  return { build: await insertSoftwareCodegenBuild(supabase, projectId, planId, specId) };
}

export async function insertSoftwareCodegenBuild(
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
      kind: 'software',
      phase: 'codegen',
      status: 'queued',
      logs: [] as unknown as Build['logs'],
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert software build');
  }
  return data as Build;
}

export async function markSoftwareBuildGenerating(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'generating' })
    .eq('id', buildId);
}

export async function markSoftwareBuildFailed(
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
    action: 'software.codegen_failed',
    actor: 'engine.software.codegen',
    detail: { build_id: buildId, message },
  });
}

export async function storeSoftwareBuildFiles(
  supabase: ForgeSupabase,
  buildId: string,
  summary: SoftwareCodegenSummary,
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

export async function completeSoftwareCodegen(
  supabase: ForgeSupabase,
  build: Build,
  summary: SoftwareCodegenSummary,
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
    action: 'software.codegen_completed',
    actor: 'engine.software.codegen',
    detail: {
      build_id: build.id,
      files_total: summary.files.length,
      scaffold_count: summary.files.filter((f) => f.source === 'scaffold').length,
      generated_count: summary.files.filter((f) => f.source === 'generated').length,
      llm_files_failed: summary.llmFilesFailed,
      slot_counts: summary.slotCounts,
      usage: summary.usage,
      attempts: summary.attempts,
      models: summary.modelsUsed,
      scaffold_id: summary.scaffoldId,
      warnings_count: summary.warnings.length,
    },
  });
}

export async function logSoftwareCodegenStarted(
  supabase: ForgeSupabase,
  build: Build,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.codegen_started',
    actor: 'engine.software.codegen',
    detail: { build_id: build.id, plan_id: build.plan_id },
  });
}
