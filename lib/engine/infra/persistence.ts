// DB helpers for the Phase 4 InfraSpec extractor. Same shape as
// lib/engine/software/persistence.ts; all four extractors write into
// the SAME `specs` table, distinguished by the `kind` discriminator
// (extended in supabase/migrations/0016_infrastructure.sql to include
// 'infrastructure').

import type { LLMUsage } from '../llm';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Spec, SpecFeedback } from '@/lib/types';
import type { ClassificationResult } from '../classify/classify';
import {
  InfraSpecSchema,
  type InfraExtractionResult,
  type InfraSpec,
} from './spec';

interface PersistArgs {
  supabase: ForgeSupabase;
  specId: string;
  projectId: string;
  result: InfraExtractionResult;
  usage: LLMUsage;
  model: string;
  attempts: number;
  feedback: SpecFeedback | null;
  source: 'generate' | 'clarify' | 'refine';
  classification?: ClassificationResult | null;
}

export async function persistInfraExtractionResult(
  args: PersistArgs,
): Promise<{ status: 'needs_clarification' | 'awaiting_review' }> {
  const { supabase, result } = args;
  const needsClarification = result.open_questions.length > 0;
  const status: 'needs_clarification' | 'awaiting_review' = needsClarification
    ? 'needs_clarification'
    : 'awaiting_review';

  // Flip kind to 'infrastructure' on every infra-extractor write. If
  // the user pivoted from agent/system/software (via the override
  // flow), the discriminator gets corrected here.
  const { error: specErr } = await supabase
    .from('specs')
    .update({
      structured_spec: result.spec as unknown as Spec['structured_spec'],
      open_questions: needsClarification ? result.open_questions : [],
      feedback: (args.feedback ?? null) as unknown as Spec['feedback'],
      kind: 'infrastructure',
      status,
    })
    .eq('id', args.specId);
  if (specErr) throw specErr;

  await supabase
    .from('projects')
    .update({ kind: 'infrastructure' })
    .eq('id', args.projectId);

  await supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'infra.draft_generated',
    actor: 'engine.infra',
    detail: {
      source: args.source,
      attempts: args.attempts,
      model: args.model,
      usage: args.usage,
      resources: result.spec.resources.length,
      topology_edges: result.spec.topology.length,
      lifecycle: result.spec.lifecycle,
      region: result.spec.region ?? null,
      open_questions_count: result.open_questions.length,
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
      action: 'infra.clarification_asked',
      actor: 'engine.infra',
      detail: {
        questions: result.open_questions,
        usage: args.usage,
        model: args.model,
      },
    });
  }

  return { status };
}

export async function confirmInfraSpec(
  supabase: ForgeSupabase,
  spec: Spec,
): Promise<InfraSpec> {
  if (!spec.structured_spec) {
    throw new Error('cannot confirm an infrastructure spec with no structured_spec');
  }
  // Re-validate at confirm time — catches drift between the schema
  // today and what was persisted earlier.
  const validation = InfraSpecSchema.safeParse(spec.structured_spec);
  if (!validation.success) {
    throw new Error('stored InfraSpec no longer matches the current schema');
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
    action: 'infra.confirmed',
    actor: 'user',
    detail: {
      spec_id: spec.id,
      resources: validation.data.resources.length,
      topology_edges: validation.data.topology.length,
      lifecycle: validation.data.lifecycle,
    },
  });

  return validation.data;
}
