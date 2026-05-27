// DB helpers for Phase 4-5b (Infrastructure) APPLY + ROLLBACK.
//
// CONTRACT enforced HERE — not by prompting:
//
//   - loadConfirmedInfraBuildForApply walks (project → confirmed
//     infra spec → approved infra plan → 'plan_confirmed' build →
//     confirmed-AND-typed-phrase-verified infra_plans row WITH a
//     persisted plan_artifact_b64). ANY missing piece → 409.
//
//   - persistInfraApplyOutcome encrypts the terraform state with
//     lib/crypto BEFORE the insert. The raw plaintext is dropped
//     from the calling scope IMMEDIATELY after the row lands. The
//     `state_present` denormalised column lets RLS-aware SELECTs
//     filter without forcing a column read.
//
//   - decryptApplyState is the ONLY decryption seam. Callers that
//     need the raw state (destroy/rollback) reach for it
//     explicitly so audits can grep one symbol.
//
//   - sanitizeInfraApplyForResponse strips the encrypted blob from
//     any client-bound payload. Outputs are kept (already sanitised
//     at the CloudProvider boundary).
//
//   - Audit helpers NEVER pass state/outputs/creds into the detail
//     blob. Only counts + classifications.

import { decryptSecret, encryptSecret } from '@/lib/crypto';
import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  InfraApply,
  InfraApplyStatus,
  InfraPlan,
  Json,
  Project,
  Spec,
  Plan,
} from '@/lib/types';
import { InfraSpecSchema, type InfraSpec } from '../spec';
import {
  ProvisioningPlanSchema,
  type ProvisioningPlan,
} from '../planner/schema';

export interface ConfirmedInfraBuildContext {
  project: Project;
  build: Build;
  spec: InfraSpec;
  plan: ProvisioningPlan;
  files: BuildFile[];
  // The confirmed plan row — guaranteed to have:
  //   - confirmed_by_user_id != null
  //   - typed_phrase_verified === true
  //   - plan_artifact_b64 != null
  // ANY of those missing → loader refuses with 409.
  infraPlanRow: InfraPlan;
}

export async function loadConfirmedInfraBuildForApply(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<ConfirmedInfraBuildContext | { error: string; status: number }> {
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

  // The loader accepts every status past plan_confirmed so destroy
  // can run from 'provisioned' / 'apply_failed' / 'destroying' /
  // 'destroyed' too. The apply route enforces its own stricter
  // requirement (plan_confirmed / apply_failed / applying) AFTER the
  // loader returns; this keeps the loader reusable across apply +
  // destroy.
  const ACCEPTABLE = new Set([
    'plan_confirmed',
    'apply_failed',
    'applying',
    'provisioned',
    'destroying',
    'destroyed',
  ]);
  if (!ACCEPTABLE.has(String(build.status))) {
    return {
      error:
        "infrastructure build is in status '" +
        build.status +
        "'; apply / destroy require a confirmed plan",
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
  if (!spec || spec.kind !== 'infrastructure') {
    return { error: 'build references a non-infrastructure spec', status: 409 };
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
  if (!plan || plan.kind !== 'infrastructure') {
    return { error: 'build references a non-infrastructure plan', status: 422 };
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

  // Latest infra_plans row — required + confirmed + artifact present.
  const { data: planRows } = await supabase
    .from('infra_plans')
    .select('*')
    .eq('build_id', build.id)
    .order('created_at', { ascending: false })
    .limit(1);
  const infraPlanRow = (planRows?.[0] as InfraPlan | undefined) ?? null;
  if (!infraPlanRow) {
    return {
      error:
        'no confirmed plan row found for this build — run /infra/build/plan + /confirm-plan first',
      status: 409,
    };
  }
  if (!infraPlanRow.confirmed_by_user_id || !infraPlanRow.typed_phrase_verified) {
    return {
      error:
        'the latest plan row is not confirmed — run /infra/build/confirm-plan first',
      status: 409,
    };
  }
  if (!infraPlanRow.plan_artifact_b64) {
    return {
      error:
        'the confirmed plan row has no saved artifact — re-run /infra/build/plan',
      status: 409,
    };
  }
  if (infraPlanRow.ceiling_verdict === 'over_budget') {
    return {
      error:
        'the confirmed plan was over budget — re-plan after raising the ceiling',
      status: 402,
    };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files,
    infraPlanRow,
  };
}

// Latest infra_applies row for a build (the apply lifecycle uses
// ONE row that the route updates in place; multiple rows only exist
// on retry).
export async function loadLatestInfraApply(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<InfraApply | null> {
  const { data, error } = await supabase
    .from('infra_applies')
    .select('*')
    .eq('build_id', buildId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as InfraApply | null) ?? null;
}

// ---------------------------------------------------------------------------
// Status flips.
// ---------------------------------------------------------------------------

export async function markInfraBuildApplying(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'applying' })
    .eq('id', buildId);
}

export async function markInfraBuildProvisioned(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'provisioned' })
    .eq('id', buildId);
}

export async function markInfraBuildApplyFailed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'apply_failed' })
    .eq('id', buildId);
}

export async function markInfraBuildDestroying(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'destroying' })
    .eq('id', buildId);
}

export async function markInfraBuildDestroyed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'destroyed' })
    .eq('id', buildId);
}

// ---------------------------------------------------------------------------
// Persist the apply outcome. Encrypts state at the boundary.
// ---------------------------------------------------------------------------

export interface PersistInfraApplyInput {
  projectId: string;
  buildId: string;
  planId: string;
  status: InfraApplyStatus;
  killswitched: boolean;
  partialState: boolean;
  resourcesAdded: number;
  resourcesChanged: number;
  resourcesDestroyed: number;
  // RAW terraform state. Encrypted BEFORE insert; the caller MUST
  // drop the plaintext reference immediately after this call.
  rawState: string | null;
  outputsSanitised: Record<string, unknown>;
  billedUsdPerMonth: number;
  errorMessage: string | null;
}

export async function persistInfraApplyOutcome(
  supabase: ForgeSupabase,
  input: PersistInfraApplyInput,
): Promise<InfraApply> {
  const stateEncrypted = input.rawState != null
    ? encryptSecret(input.rawState)
    : null;
  const row = {
    project_id: input.projectId,
    build_id: input.buildId,
    plan_id: input.planId,
    status: input.status,
    killswitched: input.killswitched,
    partial_state: input.partialState,
    resources_added: input.resourcesAdded,
    resources_changed: input.resourcesChanged,
    resources_destroyed: input.resourcesDestroyed,
    state_encrypted: stateEncrypted,
    state_present: stateEncrypted != null,
    outputs_sanitised: input.outputsSanitised as unknown as Json,
    billed_usd_per_month: input.billedUsdPerMonth,
    error_message: input.errorMessage,
    finished_at:
      input.status === 'applying' ? null : new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('infra_applies')
    .insert(row)
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert infra_applies row');
  }
  return data as InfraApply;
}

// Update an EXISTING apply row (used by the destroy path — destroy
// re-uses the same row to capture the destroy outcome alongside the
// original apply state).
export interface UpdateInfraApplyInput {
  applyId: string;
  status: InfraApplyStatus;
  killswitched?: boolean;
  partialState?: boolean;
  rawState?: string | null;
  resourcesDestroyed?: number;
  errorMessage?: string | null;
}

export async function updateInfraApplyOutcome(
  supabase: ForgeSupabase,
  input: UpdateInfraApplyInput,
): Promise<void> {
  const update: Record<string, unknown> = {
    status: input.status,
    finished_at:
      input.status === 'destroying' ? null : new Date().toISOString(),
  };
  if (input.killswitched !== undefined) update.killswitched = input.killswitched;
  if (input.partialState !== undefined) update.partial_state = input.partialState;
  if (input.resourcesDestroyed !== undefined) {
    update.resources_destroyed = input.resourcesDestroyed;
  }
  if (input.errorMessage !== undefined) update.error_message = input.errorMessage;
  if (input.rawState !== undefined) {
    const enc = input.rawState != null ? encryptSecret(input.rawState) : null;
    update.state_encrypted = enc;
    update.state_present = enc != null;
  }
  const { error } = await supabase
    .from('infra_applies')
    .update(update)
    .eq('id', input.applyId);
  if (error) throw error;
}

// The ONLY decryption seam.
export function decryptApplyState(row: InfraApply): string {
  if (!row.state_encrypted) {
    throw new Error('no encrypted state on infra_applies row ' + row.id);
  }
  return decryptSecret(row.state_encrypted);
}

// ---------------------------------------------------------------------------
// Audit helpers.
// ---------------------------------------------------------------------------

export async function logInfraApplyStarted(
  supabase: ForgeSupabase,
  build: Build,
  args: { plan_id: string; provider_kind: string; account_hint: string | null },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.apply_started',
    actor: 'engine.infra.cloud',
    detail: { build_id: build.id, ...args },
  });
}

export async function logInfraApplyCompleted(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    apply_id: string;
    resources_added: number;
    resources_changed: number;
    resources_destroyed: number;
    billed_usd_per_month: number;
    output_keys: ReadonlyArray<string>;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.apply_completed',
    actor: 'engine.infra.cloud',
    detail: {
      build_id: build.id,
      ...args,
      cloud_write_count: 1, // the ONE legitimate cloud-write event
    },
  });
}

export async function logInfraApplyFailed(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    apply_id: string | null;
    error: string;
    partial_state: boolean;
    resources_added: number;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.apply_failed',
    actor: 'engine.infra.cloud',
    detail: { build_id: build.id, ...args },
  });
}

export async function logInfraApplyKillswitched(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    apply_id: string | null;
    partial_state: boolean;
    resources_added: number;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.apply_killswitched',
    actor: 'engine.governance',
    detail: { build_id: build.id, ...args },
  });
}

export async function logRollbackRequested(
  supabase: ForgeSupabase,
  build: Build,
  args: { apply_id: string; typed_phrase_required: string },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.rollback_requested',
    actor: 'user',
    detail: { build_id: build.id, ...args },
  });
}

export async function logInfraDestroyed(
  supabase: ForgeSupabase,
  build: Build,
  args: { apply_id: string; resources_destroyed: number },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.destroyed',
    actor: 'user',
    detail: { build_id: build.id, ...args },
  });
}

// ---------------------------------------------------------------------------
// Sanitiser — boundary for the route response.
// ---------------------------------------------------------------------------

export interface PublicInfraApply {
  id: string;
  project_id: string;
  build_id: string;
  plan_id: string;
  status: string;
  killswitched: boolean;
  partial_state: boolean;
  resources_added: number;
  resources_changed: number;
  resources_destroyed: number;
  // state_encrypted is INTENTIONALLY ABSENT from this shape. The
  // boolean state_present is surfaced so the UI knows whether
  // rollback is available, but the encrypted blob never leaves the
  // server.
  state_present: boolean;
  outputs_sanitised: Record<string, unknown>;
  billed_usd_per_month: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

export function sanitizeInfraApplyForResponse(
  row: InfraApply,
): PublicInfraApply {
  return {
    id: row.id,
    project_id: row.project_id,
    build_id: row.build_id,
    plan_id: row.plan_id,
    status: row.status,
    killswitched: row.killswitched,
    partial_state: row.partial_state,
    resources_added: row.resources_added,
    resources_changed: row.resources_changed,
    resources_destroyed: row.resources_destroyed,
    state_present: row.state_present,
    outputs_sanitised:
      (row.outputs_sanitised as unknown as Record<string, unknown>) ?? {},
    billed_usd_per_month: row.billed_usd_per_month,
    error_message: row.error_message,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}
