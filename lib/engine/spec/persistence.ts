// DB helpers for the spec engine. Server-only — these touch the service-role
// Supabase client. The Supabase + LLM modules each enforce a browser guard,
// so importing this file from a client component will throw at first use.

import type { GovernanceScope, LLMUsage } from '../llm';
import type { AgentSpec, ExtractionResult } from './schema';
import type { SpecConfidence } from './confidence';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Spec, SpecFeedback } from '@/lib/types';

export async function loadLatestSpec(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<Spec | null> {
  const { data, error } = await supabase
    .from('specs')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Spec | null) ?? null;
}

export async function markSpecExtracting(
  supabase: ForgeSupabase,
  specId: string,
): Promise<void> {
  await supabase
    .from('specs')
    .update({ status: 'extracting' })
    .eq('id', specId);
}

interface PersistExtractionArgs {
  supabase: ForgeSupabase;
  specId: string;
  projectId: string;
  result: ExtractionResult;
  usage: LLMUsage;
  model: string;
  attempts: number;
  feedback: SpecFeedback | null;
  source: 'generate' | 'clarify' | 'refine';
  /**
   * Optional per-field confidence map produced by the per-mold
   * confidence helpers. Persisted to the new `specs.confidence_json`
   * column (migration 0028) when present; ignored when absent so
   * existing call sites stay valid.
   */
  fieldConfidence?: SpecConfidence;
}

export async function persistExtractionResult(
  args: PersistExtractionArgs,
): Promise<{ status: 'needs_clarification' | 'awaiting_review' }> {
  const { supabase, result } = args;
  const needsClarification = result.open_questions.length > 0;
  const status: 'needs_clarification' | 'awaiting_review' = needsClarification
    ? 'needs_clarification'
    : 'awaiting_review';

  // Build the update payload. Use index-signature assignment for
  // `confidence_json` so older Spec row types (without the column)
  // don't need a type widen here — the DB column was added by
  // migration 0028 and existing reads ignore it.
  const updatePayload: Record<string, unknown> = {
    structured_spec: result.spec as unknown as Spec['structured_spec'],
    open_questions: needsClarification ? result.open_questions : [],
    feedback: (args.feedback ?? null) as unknown as Spec['feedback'],
    status,
  };
  if (args.fieldConfidence) {
    updatePayload.confidence_json = args.fieldConfidence;
  }

  const { error } = await supabase
    .from('specs')
    .update(updatePayload)
    .eq('id', args.specId);
  if (error) throw error;

  await supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'spec.draft_generated',
    actor: 'engine.spec',
    detail: {
      source: args.source,
      attempts: args.attempts,
      model: args.model,
      usage: args.usage,
      confidence: result.spec.confidence,
      open_questions_count: result.open_questions.length,
    },
  });

  if (needsClarification) {
    await supabase.from('audit_log').insert({
      project_id: args.projectId,
      action: 'spec.clarification_asked',
      actor: 'engine.spec',
      detail: {
        questions: result.open_questions,
        usage: args.usage,
        model: args.model,
      },
    });
  }

  return { status };
}

export async function markSpecFailed(
  supabase: ForgeSupabase,
  specId: string,
  projectId: string,
  message: string,
): Promise<void> {
  await supabase.from('specs').update({ status: 'failed' }).eq('id', specId);
  await supabase.from('audit_log').insert({
    project_id: projectId,
    action: 'spec.extraction_failed',
    actor: 'engine.spec',
    detail: { message },
  });
}

export async function confirmSpec(
  supabase: ForgeSupabase,
  spec: Spec,
): Promise<AgentSpec> {
  if (!spec.structured_spec) {
    throw new Error('cannot confirm a spec with no structured_spec');
  }
  const { error: specErr } = await supabase
    .from('specs')
    .update({ status: 'confirmed' })
    .eq('id', spec.id);
  if (specErr) throw specErr;

  const { error: projErr } = await supabase
    .from('projects')
    .update({ status: 'spec_confirmed' })
    .eq('id', spec.project_id);
  if (projErr) throw projErr;

  await supabase.from('audit_log').insert({
    project_id: spec.project_id,
    action: 'spec.confirmed',
    actor: 'user',
    detail: {
      spec_id: spec.id,
    },
  });

  return spec.structured_spec as unknown as AgentSpec;
}

export function mergeFeedback(
  existing: SpecFeedback | null | undefined,
  incoming: SpecFeedback,
): SpecFeedback {
  return {
    answers: [...(existing?.answers ?? []), ...(incoming.answers ?? [])],
    refinements: [
      ...(existing?.refinements ?? []),
      ...(incoming.refinements ?? []),
    ],
  };
}

// ===========================================================================
// CLARIFICATION-LOOP AUDIT HELPERS
//
// These wrap the audit_log insert pattern for the three new events
// the bounded loop (lib/engine/spec/clarification-loop.ts) emits via
// its `audit` hook. The loop itself doesn't import a Supabase
// client — the caller passes these helpers in as the hook so the
// loop stays mockable.
//
// Detail INTENTIONALLY does not include the answer text — that
// information flows through the existing spec-mutation path
// (persistExtractionResult with `feedback.answers`). Audit only
// captures the round meta (round number, field clarified, before/
// after uncertainty counts) so the trail is greppable without
// leaking user content.
// ===========================================================================

export interface ClarificationRoundAuditArgs {
  supabase: ForgeSupabase;
  projectId: string;
  round: number;
  field: string;
  uncertaintyBefore: number;
  uncertaintyAfter: number;
  governance?: GovernanceScope;
}

export async function logSpecClarificationRound(
  args: ClarificationRoundAuditArgs,
): Promise<void> {
  await args.supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'spec.clarification_round',
    actor: 'engine.spec',
    detail: {
      round: args.round,
      field: args.field,
      uncertainty_before: args.uncertaintyBefore,
      uncertainty_after: args.uncertaintyAfter,
      governance_ref: args.governance?.ref ?? null,
    },
  });
}

export interface ClarificationMaxReachedAuditArgs {
  supabase: ForgeSupabase;
  projectId: string;
  rounds: number;
  remainingUncertaintyCount: number;
  governance?: GovernanceScope;
}

export async function logSpecClarificationMaxReached(
  args: ClarificationMaxReachedAuditArgs,
): Promise<void> {
  await args.supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'spec.clarification_max_reached',
    actor: 'engine.spec',
    detail: {
      rounds: args.rounds,
      remaining_uncertainty_count: args.remainingUncertaintyCount,
      governance_ref: args.governance?.ref ?? null,
    },
  });
}

export interface ClarificationResolvedAuditArgs {
  supabase: ForgeSupabase;
  projectId: string;
  rounds: number;
  governance?: GovernanceScope;
}

export async function logSpecClarificationResolved(
  args: ClarificationResolvedAuditArgs,
): Promise<void> {
  await args.supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'spec.clarification_resolved',
    actor: 'engine.spec',
    detail: {
      rounds: args.rounds,
      governance_ref: args.governance?.ref ?? null,
    },
  });
}
