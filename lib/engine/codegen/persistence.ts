// DB helpers for codegen. Server-only — uses the service-role Supabase
// client via getServerSupabase, which itself guards against browser imports.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  BuildLogs,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { AgentSpecSchema, type AgentSpec } from '../spec/schema';
import { BuildPlanSchema, type BuildPlan } from '../planner/schema';
import type { CodegenSummary, GeneratedFile } from './generate';

export interface ApprovedBuildContext {
  project: Project;
  spec: Spec;
  plan: Plan;
  parsedSpec: AgentSpec;
  parsedPlan: BuildPlan;
}

export async function loadApprovedPlanForCodegen(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<ApprovedBuildContext | { error: string; status: number }> {
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projErr || !project) return { error: 'project not found', status: 404 };

  const { data: specs } = await supabase
    .from('specs')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1);
  const spec = (specs?.[0] as Spec | undefined) ?? null;
  if (!spec) return { error: 'project has no spec', status: 409 };
  if (spec.status !== 'confirmed') {
    return {
      error: "spec is in status '" + spec.status + "'; must be 'confirmed'",
      status: 409,
    };
  }

  const { data: plans } = await supabase
    .from('plans')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1);
  const plan = (plans?.[0] as Plan | undefined) ?? null;
  if (!plan) return { error: 'project has no plan', status: 409 };
  if (plan.status !== 'approved') {
    return {
      error: "plan is in status '" + plan.status + "'; must be 'approved'",
      status: 409,
    };
  }

  const parsedSpec = AgentSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return {
      error: 'stored AgentSpec no longer matches the current schema',
      status: 422,
    };
  }
  const parsedPlan = BuildPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return {
      error: 'stored BuildPlan no longer matches the current schema',
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

export async function loadLatestBuild(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Build | null> {
  const { data, error } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Build | null) ?? null;
}

export async function ensureCodegenBuild(
  supabase: ForgeSupabase,
  projectId: string,
  planId: string,
  specId: string,
): Promise<
  | { build: Build }
  | { error: string; status: number }
> {
  const existing = await loadLatestBuild(supabase, projectId);
  if (existing && existing.plan_id === planId) {
    if (
      existing.status === 'generated' ||
      existing.status === 'running' ||
      existing.status === 'success'
    ) {
      return {
        error:
          "latest build is in status '" +
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
  return { build: await insertCodegenBuild(supabase, projectId, planId, specId) };
}

export async function insertCodegenBuild(
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
      phase: 'codegen',
      status: 'queued',
      logs: [] as unknown as Build['logs'],
    })
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('failed to insert build');
  return data as Build;
}

export async function markBuildGenerating(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'generating' })
    .eq('id', buildId);
}

export async function markBuildFailed(
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
    action: 'build.codegen_failed',
    actor: 'engine.codegen',
    detail: { build_id: buildId, message },
  });
}

export async function storeBuildFiles(
  supabase: ForgeSupabase,
  buildId: string,
  files: GeneratedFile[],
): Promise<void> {
  // Clear any stale rows from a previous attempt on the same build_id so the
  // (build_id, path) unique constraint doesn't conflict on retries.
  const { error: delErr } = await supabase
    .from('build_files')
    .delete()
    .eq('build_id', buildId);
  if (delErr) throw delErr;

  if (files.length === 0) return;

  const rows = files.map((f) => ({
    build_id: buildId,
    path: f.path,
    content: f.content,
    source: f.source,
    bytes: f.bytes,
  }));

  const { error } = await supabase.from('build_files').insert(rows);
  if (error) throw error;
}

export async function completeCodegen(
  supabase: ForgeSupabase,
  build: Build,
  summary: CodegenSummary,
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
    action: 'build.codegen_completed',
    actor: 'engine.codegen',
    detail: {
      build_id: build.id,
      files_total: summary.files.length,
      scaffold_count: summary.files.filter((f) => f.source === 'scaffold').length,
      generated_count: summary.files.filter((f) => f.source === 'generated').length,
      llm_files_failed: summary.llmFilesFailed,
      usage: summary.usage,
      attempts: summary.attempts,
      models: summary.models,
      scaffold_id: summary.scaffoldId,
      warnings_count: summary.warnings.length,
    },
  });
}

export async function logCodegenStarted(
  supabase: ForgeSupabase,
  build: Build,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'build.codegen_started',
    actor: 'engine.codegen',
    detail: { build_id: build.id, plan_id: build.plan_id },
  });
}

export async function loadBuildFiles(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<BuildFile[]> {
  const { data, error } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', buildId)
    .order('path', { ascending: true });
  if (error) throw error;
  return (data ?? []) as BuildFile[];
}
