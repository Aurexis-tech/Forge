// DB helpers for the Phase 2 system extractor. Same shape as
// lib/engine/spec/persistence.ts — both write into the SAME `specs`
// table, distinguished by the `kind` discriminator column added in
// supabase/migrations/0012_systems.sql.

import type { LLMUsage } from '../llm';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Spec, SpecFeedback } from '@/lib/types';
import type { ClassificationResult } from '../classify/classify';
import {
  SystemSpecSchema,
  type SystemExtractionResult,
  type SystemSpec,
} from './spec';

interface PersistArgs {
  supabase: ForgeSupabase;
  specId: string;
  projectId: string;
  result: SystemExtractionResult;
  usage: LLMUsage;
  model: string;
  attempts: number;
  feedback: SpecFeedback | null;
  source: 'generate' | 'clarify' | 'refine';
  // Pass the classifier metadata for the audit trail when this is the
  // first generate (source='generate'). Optional thereafter.
  classification?: ClassificationResult | null;
}

export async function persistSystemExtractionResult(
  args: PersistArgs,
): Promise<{ status: 'needs_clarification' | 'awaiting_review' }> {
  const { supabase, result } = args;
  const needsClarification = result.open_questions.length > 0;
  const status: 'needs_clarification' | 'awaiting_review' = needsClarification
    ? 'needs_clarification'
    : 'awaiting_review';

  // The spec row is the source of truth for the `kind` discriminator.
  // Flip it to 'system' on every system-extractor write so a spec that
  // was previously misclassified as 'agent' but is being re-extracted
  // as a system gets corrected here.
  const { error: specErr } = await supabase
    .from('specs')
    .update({
      structured_spec: result.spec as unknown as Spec['structured_spec'],
      open_questions: needsClarification ? result.open_questions : [],
      feedback: (args.feedback ?? null) as unknown as Spec['feedback'],
      kind: 'system',
      status,
    })
    .eq('id', args.specId);
  if (specErr) throw specErr;

  // Mirror the kind onto the project row so the project list / detail
  // page can show the right badge without re-reading the spec row.
  await supabase
    .from('projects')
    .update({ kind: 'system' })
    .eq('id', args.projectId);

  await supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'system.draft_generated',
    actor: 'engine.system',
    detail: {
      source: args.source,
      attempts: args.attempts,
      model: args.model,
      usage: args.usage,
      sub_agents: result.spec.sub_agents.length,
      coordination: result.spec.coordination.pattern,
      max_steps: result.spec.max_steps,
      open_questions_count: result.open_questions.length,
      // The classifier's verdict is captured ONLY when it was actually
      // consulted — i.e. on the initial generate. Clarify/refine reuse
      // the already-set kind without re-classifying.
      classification: args.classification
        ? {
            kind: args.classification.kind,
            confidence: args.classification.confidence,
            why: args.classification.why,
            model: args.classification.model,
          }
        : null,
    },
  });

  if (needsClarification) {
    await supabase.from('audit_log').insert({
      project_id: args.projectId,
      action: 'system.clarification_asked',
      actor: 'engine.system',
      detail: {
        questions: result.open_questions,
        usage: args.usage,
        model: args.model,
      },
    });
  }

  return { status };
}

export async function confirmSystemSpec(
  supabase: ForgeSupabase,
  spec: Spec,
): Promise<SystemSpec> {
  if (!spec.structured_spec) {
    throw new Error('cannot confirm a system spec with no structured_spec');
  }
  // Re-validate at confirm time — catches drift between the schema
  // today and what was persisted earlier.
  const validation = SystemSpecSchema.safeParse(spec.structured_spec);
  if (!validation.success) {
    throw new Error('stored SystemSpec no longer matches the current schema');
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
    action: 'system.confirmed',
    actor: 'user',
    detail: {
      spec_id: spec.id,
      sub_agents: validation.data.sub_agents.length,
      coordination: validation.data.coordination.pattern,
    },
  });

  return validation.data;
}
