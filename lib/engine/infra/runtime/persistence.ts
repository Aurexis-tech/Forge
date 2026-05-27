// DB helpers for Phase 4-6 (Infrastructure) MONITORING + DRIFT.
//
// Provisioned infra is standing in real cloud accruing real cost.
// "Runtime" for infra is monitoring (NOT a scheduled executor):
//   - the apply row's sanitised outputs (masked further if a key
//     name looks secret — defence in depth on top of the
//     CloudProvider boundary sanitiser)
//   - the LIVE accrued cost from the ledger vs the budget cap
//   - DRIFT status (latest infra_drift_checks row)
//   - kill-switch FREEZE state (active → all forward action blocked,
//     dashboard surfaces "frozen". NEVER auto-destroys.)
//   - lifecycle TTL reminder when the InfraSpec is ephemeral
//   - gated teardown control (reuses /infra/build/destroy)
//
// CONTRACT enforced HERE — not by prompting:
//
//   - assembleInfraDashboard receives ONLY the sanitised pieces;
//     the encrypted state column is NEVER read inside this function.
//     The output type intentionally has no state-blob field.
//   - Output values that look secret-named are masked verbatim into
//     '[redacted · secret-named key]'.
//   - The kill switch FREEZES — no auto-destroy. The dashboard reads
//     the active kill switch and surfaces the frozen flag; clearing
//     the switch unfreezes (the user re-runs whatever they wanted).

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  InfraApply,
  InfraDriftCheck,
  Project,
} from '@/lib/types';
import type { InfraSpec } from '@/lib/engine/infra/spec';

const MASKED_KEY_RE = /^(secret|password|token|key|credential|api_key)$/i;

// ---------------------------------------------------------------------------
// Loaders.
// ---------------------------------------------------------------------------

export async function loadLatestInfraDriftCheck(
  supabase: ForgeSupabase,
  applyId: string,
): Promise<InfraDriftCheck | null> {
  const { data, error } = await supabase
    .from('infra_drift_checks')
    .select('*')
    .eq('apply_id', applyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as InfraDriftCheck | null) ?? null;
}

// ---------------------------------------------------------------------------
// Drift persistence.
// ---------------------------------------------------------------------------

export interface PersistInfraDriftCheckInput {
  projectId: string;
  buildId: string;
  applyId: string;
  verdict: 'in_sync' | 'drifted' | 'failed';
  createCount: number;
  changeCount: number;
  destroyCount: number;
  diffSummary: Record<string, unknown> | null;
  errorMessage: string | null;
}

export async function persistInfraDriftCheck(
  supabase: ForgeSupabase,
  input: PersistInfraDriftCheckInput,
): Promise<InfraDriftCheck> {
  const { data, error } = await supabase
    .from('infra_drift_checks')
    .insert({
      project_id: input.projectId,
      build_id: input.buildId,
      apply_id: input.applyId,
      verdict: input.verdict,
      create_count: input.createCount,
      change_count: input.changeCount,
      destroy_count: input.destroyCount,
      diff_summary:
        input.diffSummary as unknown as InfraDriftCheck['diff_summary'],
      error_message: input.errorMessage,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert infra_drift_checks row');
  }
  return data as InfraDriftCheck;
}

// ---------------------------------------------------------------------------
// Audit helpers.
// ---------------------------------------------------------------------------

export async function logInfraDriftStarted(
  supabase: ForgeSupabase,
  build: Build,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.drift_check_started',
    actor: 'engine.infra.runtime',
    detail: { build_id: build.id },
  });
}

export async function logInfraDriftChecked(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    drift_id: string;
    verdict: 'in_sync' | 'drifted' | 'failed';
    create_count: number;
    change_count: number;
    destroy_count: number;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.drift_checked',
    actor: 'engine.infra.runtime',
    detail: {
      build_id: build.id,
      ...args,
      // Drift is a read-only re-plan — same boundary markers as P4-5a.
      terraform_apply_invoked: false,
      cloud_write_count: 0,
    },
  });
}

export async function logInfraFrozen(
  supabase: ForgeSupabase,
  build: Build,
  reason: string | null,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'infra.frozen',
    actor: 'engine.governance',
    detail: { build_id: build.id, reason },
  });
}

// ---------------------------------------------------------------------------
// Dashboard payload assembly.
//
// The InfraMonitorDashboard component receives ONLY this shape. The
// payload's TYPE has no encrypted-state field by construction. The
// output values are double-masked (CloudProvider's boundary
// sanitiser stripped secret-shaped strings; the assembler additionally
// masks secret-named KEYS).
// ---------------------------------------------------------------------------

export interface InfraDashboardPayload {
  // Header / status.
  live: boolean;
  frozen: boolean;
  project_id: string;
  project_name: string;
  build_id: string;
  // Lifecycle reminder. When the InfraSpec declared `ephemeral`, the
  // dashboard surfaces a prominent "tear me down" reminder.
  lifecycle: 'ephemeral' | 'persistent' | string;
  region: string | null;
  // Apply / resources.
  apply_id: string;
  resources_added: number;
  resources_changed: number;
  resources_destroyed: number;
  partial_state: boolean;
  // Outputs — secret-named keys are masked. The encrypted state blob
  // is intentionally absent from this payload.
  outputs_masked: Record<string, unknown>;
  // Costs.
  billed_usd_per_month: number;
  accrued_usd_total: number;
  // Cost-ceiling snapshot from the user's budget.
  ceiling_period: 'monthly' | 'daily' | null;
  ceiling_limit_usd: number | null;
  // Drift.
  drift: {
    verdict: 'in_sync' | 'drifted' | 'failed' | 'unknown';
    create_count: number;
    change_count: number;
    destroy_count: number;
    checked_at: string | null;
  };
  // Kill switch — drives the "frozen" banner.
  kill_switch: {
    active: boolean;
    scope: 'global' | 'user' | 'project' | null;
    reason: string | null;
  };
  // Spec summary — plain-language "what this infrastructure is".
  summary: {
    goal: string;
    resource_count: number;
    has_ephemeral_lifecycle: boolean;
  };
  // The phrase the gated teardown demands — denormalised onto the
  // payload so the client never has to look it up.
  typed_phrase_required: string | null;
}

export interface AssembleInfraDashboardInput {
  project: Project;
  build: Build;
  spec: InfraSpec;
  apply: InfraApply;
  // Latest drift check, if one's been run. Null → 'unknown' verdict.
  drift: InfraDriftCheck | null;
  // Real spend on this project from the ledger.
  accruedUsdTotal: number;
  // Cost-ceiling snapshot from the user's budget rows.
  ceilingPeriod: 'monthly' | 'daily' | null;
  ceilingLimitUsd: number | null;
  // Kill-switch state. The route reads activeKillSwitch and passes
  // through; the FREEZE behaviour lives in assertAllowed already.
  killSwitch: {
    active: boolean;
    scope: 'global' | 'user' | 'project' | null;
    reason: string | null;
  };
  typedPhraseRequired: string | null;
}

export function assembleInfraDashboard(
  input: AssembleInfraDashboardInput,
): InfraDashboardPayload {
  // Mask secret-named keys on the way out. The CloudProvider's
  // boundary sanitiser already scrubbed secret-shaped VALUES; this
  // is defence in depth against keys named e.g. 'password' whose
  // value is non-secret-shaped but probably shouldn't render.
  const rawOutputs =
    (input.apply.outputs_sanitised as unknown as Record<
      string,
      unknown
    >) ?? {};
  const outputs_masked: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawOutputs)) {
    outputs_masked[k] = MASKED_KEY_RE.test(k)
      ? '[redacted · secret-named key]'
      : v;
  }

  const driftVerdict: InfraDashboardPayload['drift']['verdict'] = input.drift
    ? (input.drift.verdict as 'in_sync' | 'drifted' | 'failed')
    : 'unknown';

  return {
    live:
      input.build.status === 'provisioned' && !input.killSwitch.active,
    frozen: input.killSwitch.active,
    project_id: input.project.id,
    project_name: input.project.name,
    build_id: input.build.id,
    lifecycle: input.spec.lifecycle,
    region: input.spec.region ?? null,
    apply_id: input.apply.id,
    resources_added: input.apply.resources_added,
    resources_changed: input.apply.resources_changed,
    resources_destroyed: input.apply.resources_destroyed,
    partial_state: input.apply.partial_state,
    outputs_masked,
    billed_usd_per_month: input.apply.billed_usd_per_month,
    accrued_usd_total: input.accruedUsdTotal,
    ceiling_period: input.ceilingPeriod,
    ceiling_limit_usd: input.ceilingLimitUsd,
    drift: {
      verdict: driftVerdict,
      create_count: input.drift?.create_count ?? 0,
      change_count: input.drift?.change_count ?? 0,
      destroy_count: input.drift?.destroy_count ?? 0,
      checked_at: input.drift?.created_at ?? null,
    },
    kill_switch: input.killSwitch,
    summary: {
      goal: input.spec.goal,
      resource_count: input.spec.resources.length,
      has_ephemeral_lifecycle: input.spec.lifecycle === 'ephemeral',
    },
    typed_phrase_required: input.typedPhraseRequired,
  };
}
