// DB helpers for Phase 4-5a (Infrastructure) REAL TERRAFORM PLAN +
// TYPED DESTRUCTIVE-CONFIRM gate. Same shape as the other
// software/system/infra additive-persistence modules.
//
// CONTRACT enforced HERE — not by prompting:
//
//   - loadPreviewedInfraBuildForPlan walks (project → confirmed infra
//     spec → approved infra plan → 'previewed' build → 'within_budget'
//     OR 'no_budget_set' preview). A 'generated' or 'preview_blocked'
//     build is REFUSED here (the P4-4 ceiling gate is a hard
//     prerequisite). The latest preview row's verdict must be a
//     passing one; a missing or over-budget preview row -> 402.
//
//   - persistInfraPlan writes one infra_plans row per gate attempt.
//     The plan_diff blob is whatever the CloudProvider returned
//     (already sanitised at the boundary — no raw secrets). The
//     ceiling re-check verdict + binding cap are denormalised onto
//     columns for fast UI rendering.
//
//   - confirmInfraPlan persists the gate outcome: for pure-create
//     plans, AuthorizationGate sets `typed_phrase_verified=true`
//     vacuously; for destructive plans, the route layer MUST verify
//     the typed phrase EXACTLY before calling this helper. We carry
//     `typed_phrase_required` to make audit replay possible.
//
//   - NEVER pass raw cloud creds or secret values into the detail
//     blob of any audit row.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  InfraPlan,
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
import type { CeilingCheck } from '../preview/ceiling';
import type { InfraPlanDiff } from './provider';

export interface PreviewedInfraBuildContext {
  project: Project;
  build: Build;
  spec: InfraSpec;
  plan: ProvisioningPlan;
  files: BuildFile[];
  // The latest preview row (P4-4). Required, passing — the loader
  // refuses anything else.
  preview: InfraPreview;
}

// Walks the chain. Refuses every misroute. Two distinct refusal
// shapes the route layer surfaces with different HTTP statuses:
//   - 409 for shape/route errors (wrong kind, wrong status, missing
//     plan/spec)
//   - 402 for "P4-4 preview was over budget; raise the ceiling and
//     re-preview before trying to plan"
export async function loadPreviewedInfraBuildForPlan(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<PreviewedInfraBuildContext | { error: string; status: number }> {
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

  // HARD prerequisite — only a 'previewed' build (or a previously
  // 'plan_blocked' build, to allow retries after the user raises
  // their ceiling or the destructive gate is re-attempted) reaches
  // the plan layer. 'plan_confirmed' is also acceptable for re-runs
  // (e.g. drift detection); 'generated' and 'preview_blocked' are
  // REFUSED here.
  if (build.status === 'generated') {
    return {
      error:
        "infrastructure build is in status 'generated' — run the P4-4 preview first",
      status: 409,
    };
  }
  if (build.status === 'preview_blocked') {
    return {
      error:
        "infrastructure build is in status 'preview_blocked' — the P4-4 preview was over budget; raise your ceiling or trim the spec, then re-preview before planning",
      status: 402,
    };
  }
  if (
    build.status !== 'previewed' &&
    build.status !== 'planning' &&
    build.status !== 'plan_blocked' &&
    build.status !== 'plan_confirmed'
  ) {
    return {
      error:
        "infrastructure build is in status '" +
        build.status +
        "'; only 'previewed' (or a prior 'plan_*' for retry) can be planned",
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
      error: 'stored ProvisioningPlan no longer matches the current schema',
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

  // Latest infra_previews row for this build — required + passing.
  const { data: previewRows } = await supabase
    .from('infra_previews')
    .select('*')
    .eq('build_id', build.id)
    .order('created_at', { ascending: false })
    .limit(1);
  const preview = (previewRows?.[0] as InfraPreview | undefined) ?? null;
  if (!preview) {
    return {
      error:
        'no P4-4 preview exists for this build — run the preview first',
      status: 409,
    };
  }
  if (preview.ceiling_verdict === 'over_budget') {
    return {
      error:
        'P4-4 preview was over budget — raise the ceiling or trim the spec, then re-preview before planning',
      status: 402,
    };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files,
    preview,
  };
}

// Latest infra plan row for a build.
export async function loadLatestInfraPlanRow(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<InfraPlan | null> {
  const { data, error } = await supabase
    .from('infra_plans')
    .select('*')
    .eq('build_id', buildId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as InfraPlan | null) ?? null;
}

// ---------------------------------------------------------------------------
// Status flips.
// ---------------------------------------------------------------------------

export async function markInfraBuildPlanning(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'planning' })
    .eq('id', buildId);
}

export async function markInfraBuildPlanBlocked(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'plan_blocked' })
    .eq('id', buildId);
}

export async function markInfraBuildPlanConfirmed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'plan_confirmed' })
    .eq('id', buildId);
}

// When the user backs out of the gate without confirming, the build
// returns to 'previewed' so a fresh plan can be run later.
export async function markInfraBuildPlanRolledBack(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'previewed' })
    .eq('id', buildId);
}

// ---------------------------------------------------------------------------
// Persist the real plan diff + ceiling re-check verdict.
// ---------------------------------------------------------------------------

export interface PersistInfraPlanInput {
  projectId: string;
  buildId: string;
  diff: InfraPlanDiff;
  ceiling: CeilingCheck;
  // The typed phrase the destructive gate WILL require. For
  // pure-create plans this is null and the AuthorizationGate is
  // sufficient. For destructive plans it's the exact string the user
  // must type to confirm — denormalised onto the row so the audit
  // record + the confirm-plan route can both read it.
  typedPhraseRequired: string | null;
  // Phase 4-5b: the base64-encoded `terraform plan -out=...` binary
  // file. The apply step reads this back and runs `terraform apply
  // <file>` so what's applied is EXACTLY what the user confirmed.
  // Server-only; never returned in any client-bound response.
  planArtifactB64: string;
}

export async function persistInfraPlanRow(
  supabase: ForgeSupabase,
  input: PersistInfraPlanInput,
): Promise<InfraPlan> {
  const row = {
    project_id: input.projectId,
    build_id: input.buildId,
    plan_diff: input.diff as unknown as Json,
    destructive: input.diff.destructive,
    create_count: input.diff.create_count,
    change_count: input.diff.change_count,
    destroy_count: input.diff.destroy_count + input.diff.replace_count,
    ceiling_verdict: input.ceiling.verdict,
    ceiling_period: input.ceiling.binding_period,
    ceiling_limit_usd: input.ceiling.binding_limit_usd,
    ceiling_projected_usd: input.ceiling.projected_usd_for_binding,
    ceiling_message: input.ceiling.message,
    confirmed_by_user_id: null,
    typed_phrase_required: input.typedPhraseRequired,
    typed_phrase_verified: false,
    confirmed_at: null,
    plan_artifact_b64: input.planArtifactB64,
  };
  const { data, error } = await supabase
    .from('infra_plans')
    .insert(row)
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert infra_plans row');
  }
  return data as InfraPlan;
}

export interface ConfirmInfraPlanInput {
  planId: string;
  userId: string;
  // True iff a destructive plan whose typed phrase was verified EXACTLY
  // server-side. For pure-create plans, the AuthorizationGate counts
  // as "vacuously verified" — pass true with typedPhraseRequired=null.
  typedPhraseVerified: boolean;
}

export async function confirmInfraPlanRow(
  supabase: ForgeSupabase,
  input: ConfirmInfraPlanInput,
): Promise<void> {
  const { error } = await supabase
    .from('infra_plans')
    .update({
      confirmed_by_user_id: input.userId,
      typed_phrase_verified: input.typedPhraseVerified,
      confirmed_at: new Date().toISOString(),
    })
    .eq('id', input.planId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Audit helpers. NEVER pass raw cloud creds, secret values, or the
// terraform plan's RAW stdout into the detail blob — only the
// sanitised counts + classifications.
// ---------------------------------------------------------------------------

export async function logInfraPlanStarted(
  supabase: ForgeSupabase,
  build: Build,
  args: { provider_kind: string; account_hint: string | null },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.plan_started',
    actor: 'engine.infra.cloud',
    detail: {
      build_id: build.id,
      ...args,
      // The boundary marker — same as P4-3 / P4-4. The plan is
      // READ-ONLY against cloud state; nothing is applied here.
      terraform_apply_invoked: false,
      cloud_write_count: 0,
    },
  });
}

export async function logInfraPlanCompleted(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    plan_id: string;
    create_count: number;
    change_count: number;
    destroy_count: number;
    replace_count: number;
    destructive: boolean;
    ceiling_verdict: 'within_budget' | 'no_budget_set';
    ceiling_period: 'monthly' | 'daily' | null;
    ceiling_limit_usd: number | null;
    typed_confirm_required: boolean;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.plan_completed',
    actor: 'engine.infra.cloud',
    detail: {
      build_id: build.id,
      ...args,
      terraform_apply_invoked: false,
      cloud_write_count: 0,
    },
  });
}

export async function logInfraPlanOverBudget(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    plan_id: string;
    estimated_usd_per_month: number;
    ceiling_period: 'monthly' | 'daily';
    ceiling_limit_usd: number;
    ceiling_projected_usd: number;
    message: string;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.plan_over_budget',
    actor: 'engine.governance',
    detail: {
      build_id: build.id,
      ...args,
      terraform_apply_invoked: false,
      cloud_write_count: 0,
    },
  });
}

export async function logDestructiveConfirmRequired(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    plan_id: string;
    destroy_count: number;
    replace_count: number;
    change_count: number;
    typed_phrase_required: string;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.destructive_confirm_required',
    actor: 'engine.infra.cloud',
    detail: {
      build_id: build.id,
      ...args,
      terraform_apply_invoked: false,
      cloud_write_count: 0,
    },
  });
}

export async function logInfraPlanConfirmed(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    plan_id: string;
    destructive: boolean;
    typed_phrase_verified: boolean;
    create_count: number;
    change_count: number;
    destroy_count: number;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.plan_confirmed',
    actor: 'user',
    detail: {
      build_id: build.id,
      ...args,
      terraform_apply_invoked: false,
      cloud_write_count: 0,
    },
  });
}

export async function logInfraPlanFailed(
  supabase: ForgeSupabase,
  build: Build,
  message: string,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.plan_failed',
    actor: 'engine.infra.cloud',
    detail: { build_id: build.id, error: message },
  });
}

// ---------------------------------------------------------------------------
// Sanitiser — boundary for the route response.
// ---------------------------------------------------------------------------

export interface PublicInfraPlan {
  id: string;
  project_id: string;
  build_id: string;
  destructive: boolean;
  create_count: number;
  change_count: number;
  destroy_count: number;
  ceiling_verdict: string;
  ceiling_period: string | null;
  ceiling_limit_usd: number | null;
  ceiling_projected_usd: number | null;
  ceiling_message: string;
  // The plan_diff is already sanitised at the cloud-provider boundary
  // (no secret-shaped strings). Pass through verbatim.
  plan_diff: InfraPlanDiff;
  typed_phrase_required: string | null;
  typed_phrase_verified: boolean;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export function sanitizeInfraPlanForResponse(row: InfraPlan): PublicInfraPlan {
  // The `plan_artifact_b64` field is INTENTIONALLY ABSENT from this
  // shape — the artifact is server-only. The apply route reads it
  // directly from the DB row; the client never sees it.
  return {
    id: row.id,
    project_id: row.project_id,
    build_id: row.build_id,
    destructive: row.destructive,
    create_count: row.create_count,
    change_count: row.change_count,
    destroy_count: row.destroy_count,
    ceiling_verdict: row.ceiling_verdict,
    ceiling_period: row.ceiling_period,
    ceiling_limit_usd: row.ceiling_limit_usd,
    ceiling_projected_usd: row.ceiling_projected_usd,
    ceiling_message: row.ceiling_message,
    plan_diff: row.plan_diff as unknown as InfraPlanDiff,
    typed_phrase_required: row.typed_phrase_required,
    typed_phrase_verified: row.typed_phrase_verified,
    confirmed_by_user_id: row.confirmed_by_user_id,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
  };
}
