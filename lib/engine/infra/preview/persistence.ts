// DB helpers for Phase 4-4 (Infrastructure) PREVIEW. Same shape as
// the other software/system additive-persistence modules.
//
// CONTRACT enforced HERE — not by prompting:
//
//   - loadGeneratedInfraBuildForPreview walks the
//     (project → confirmed infra spec → approved infra plan →
//     'generated' build) chain and 409s every misroute, including
//     non-infra kinds.
//   - persistInfraPreview writes ONE infra_previews row per preview
//     attempt; an over-budget verdict still persists (so the audit +
//     UI have the receipt) but the build status reflects the gate
//     ('preview_blocked' vs 'previewed').
//   - The preview blob is INERT — derived from the catalog + plan +
//     composed IaC. No cloud call. No terraform plan/apply.
//   - sanitizeInfraPreviewForResponse strips internal fields the
//     client doesn't need; the preview blob carries no secrets.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  InfraPreview,
  Json,
  Plan,
  Project,
  Spec,
} from '@/lib/types';
import { InfraSpecSchema, type InfraSpec } from '../spec';
import {
  ProvisioningPlanSchema,
  type ProvisioningPlan,
} from '../planner/schema';
import type { CeilingCheck } from './ceiling';
import type { InfraPreviewResult } from './derive';

export interface GeneratedInfraBuildContext {
  project: Project;
  build: Build;
  spec: InfraSpec;
  plan: ProvisioningPlan;
  files: BuildFile[];
}

// Walks the (project → spec → plan → 'generated' build → files)
// chain. Refuses every misroute with a clean 409. The build MUST be
// kind='infrastructure' AND status in {'generated','preview_blocked'}
// — the latter so a user can re-run preview after raising their
// ceiling without going back to codegen.
export async function loadGeneratedInfraBuildForPreview(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<GeneratedInfraBuildContext | { error: string; status: number }> {
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projErr || !project) return { error: 'project not found', status: 404 };

  const { data: builds } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'infrastructure')
    .order('created_at', { ascending: false })
    .limit(1);
  const build = (builds?.[0] as Build | undefined) ?? null;
  if (!build) {
    return { error: 'project has no infrastructure build', status: 409 };
  }

  // Acceptable statuses:
  //   - 'generated'       — codegen passed (P4-3); first preview
  //   - 'preview_blocked' — previous preview was over budget; the
  //                         user raised their cap and is re-running
  //   - 'previewed'       — preview already passed; re-running just
  //                         refreshes the verdict (no harm done)
  // NOT 'pushing'/'pushed'/'deploying'/'deployed' — those imply
  // provision/apply has fired, which P4-4 is the gate for.
  if (
    build.status !== 'generated' &&
    build.status !== 'preview_blocked' &&
    build.status !== 'previewed'
  ) {
    return {
      error:
        "infrastructure build is in status '" +
        build.status +
        "'; only 'generated' (or 'preview_blocked' / 'previewed' for retry) can be previewed",
      status: 409,
    };
  }
  if (!build.spec_id || !build.plan_id) {
    return {
      error: 'infrastructure build is missing spec_id or plan_id',
      status: 422,
    };
  }

  const { data: specRow } = await supabase
    .from('specs')
    .select('*')
    .eq('id', build.spec_id)
    .single();
  const spec = (specRow as Spec | null) ?? null;
  if (!spec) return { error: 'build references a missing spec', status: 422 };
  if (spec.kind !== 'infrastructure') {
    return {
      error:
        "build references a non-infrastructure spec (kind='" + spec.kind + "')",
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

  const { data: planRow } = await supabase
    .from('plans')
    .select('*')
    .eq('id', build.plan_id)
    .single();
  const plan = (planRow as Plan | null) ?? null;
  if (!plan) return { error: 'build references a missing plan', status: 422 };
  if (plan.kind !== 'infrastructure') {
    return {
      error:
        "build references a non-infrastructure plan (kind='" + plan.kind + "')",
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

  const { data: filesData } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  const files = (filesData ?? []) as BuildFile[];
  if (files.length === 0) {
    return { error: 'infrastructure build has no files', status: 422 };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files,
  };
}

// Latest preview row for a given build.
export async function loadLatestInfraPreview(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<InfraPreview | null> {
  const { data, error } = await supabase
    .from('infra_previews')
    .select('*')
    .eq('build_id', buildId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as InfraPreview | null) ?? null;
}

// ---------------------------------------------------------------------------
// Status flips.
// ---------------------------------------------------------------------------

export async function markInfraBuildPreviewing(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'previewing' })
    .eq('id', buildId);
}

export async function markInfraBuildPreviewed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'previewed' })
    .eq('id', buildId);
}

export async function markInfraBuildPreviewBlocked(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'preview_blocked' })
    .eq('id', buildId);
}

// ---------------------------------------------------------------------------
// Persist the preview row + the ceiling verdict together.
// ---------------------------------------------------------------------------

export interface PersistInfraPreviewInput {
  projectId: string;
  buildId: string;
  preview: InfraPreviewResult;
  ceiling: CeilingCheck;
}

export async function persistInfraPreview(
  supabase: ForgeSupabase,
  input: PersistInfraPreviewInput,
): Promise<InfraPreview> {
  const row = {
    project_id: input.projectId,
    build_id: input.buildId,
    estimated_usd_per_month: input.preview.total_usd_per_month,
    estimated_usd_per_hour: input.preview.total_usd_per_hour,
    ceiling_verdict: input.ceiling.verdict,
    ceiling_period: input.ceiling.binding_period,
    ceiling_limit_usd: input.ceiling.binding_limit_usd,
    ceiling_projected_usd: input.ceiling.projected_usd_for_binding,
    preview: input.preview as unknown as Json,
    ceiling_message: input.ceiling.message,
  };
  const { data, error } = await supabase
    .from('infra_previews')
    .insert(row)
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert infra_previews row');
  }
  return data as InfraPreview;
}

// ---------------------------------------------------------------------------
// Audit helpers.
// ---------------------------------------------------------------------------

export async function logInfraPreviewStarted(
  supabase: ForgeSupabase,
  build: Build,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.preview_started',
    actor: 'engine.infra.preview',
    detail: { build_id: build.id },
  });
}

export async function logInfraPreviewCompleted(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    preview_id: string;
    estimated_usd_per_month: number;
    estimated_usd_per_hour: number;
    ceiling_verdict: 'within_budget' | 'no_budget_set';
    ceiling_period: 'monthly' | 'daily' | null;
    ceiling_limit_usd: number | null;
    public_exposure_opt_ins: ReadonlyArray<string>;
    resource_count: number;
    module_count: number;
    // The same boundary markers the codegen audit row carries — the
    // preview is inert and we record that explicitly.
    cloud_calls: 0;
    terraform_plan_invoked: false;
    terraform_apply_invoked: false;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.preview_completed',
    actor: 'engine.infra.preview',
    detail: { build_id: build.id, ...args },
  });
}

export async function logInfraPreviewOverBudget(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    preview_id: string;
    estimated_usd_per_month: number;
    ceiling_period: 'monthly' | 'daily';
    ceiling_limit_usd: number;
    ceiling_projected_usd: number;
    message: string;
    cloud_calls: 0;
    terraform_plan_invoked: false;
    terraform_apply_invoked: false;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.preview_over_budget',
    actor: 'engine.governance',
    detail: { build_id: build.id, ...args },
  });
}

export async function logInfraPreviewFailed(
  supabase: ForgeSupabase,
  build: Build,
  message: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.preview_failed',
    actor: 'engine.infra.preview',
    detail: { build_id: build.id, error: message },
  });
}

// ---------------------------------------------------------------------------
// Sanitiser — what the route returns to the client. The preview blob
// carries no secrets by construction; we still pass it through this
// helper so the response shape stays stable + version-aware.
// ---------------------------------------------------------------------------

export interface PublicInfraPreview {
  id: string;
  project_id: string;
  build_id: string;
  estimated_usd_per_month: number;
  estimated_usd_per_hour: number;
  ceiling_verdict: string;
  ceiling_period: string | null;
  ceiling_limit_usd: number | null;
  ceiling_projected_usd: number | null;
  ceiling_message: string;
  preview: InfraPreviewResult;
  created_at: string;
}

export function sanitizeInfraPreviewForResponse(
  row: InfraPreview,
): PublicInfraPreview {
  return {
    id: row.id,
    project_id: row.project_id,
    build_id: row.build_id,
    estimated_usd_per_month: row.estimated_usd_per_month,
    estimated_usd_per_hour: row.estimated_usd_per_hour,
    ceiling_verdict: row.ceiling_verdict,
    ceiling_period: row.ceiling_period,
    ceiling_limit_usd: row.ceiling_limit_usd,
    ceiling_projected_usd: row.ceiling_projected_usd,
    ceiling_message: row.ceiling_message,
    preview: row.preview as unknown as InfraPreviewResult,
    created_at: row.created_at,
  };
}
