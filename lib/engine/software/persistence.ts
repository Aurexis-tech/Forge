// DB helpers for the Phase 3 SoftwareSpec extractor. Same shape as
// lib/engine/system/persistence.ts; all three extractors write into
// the SAME `specs` table, distinguished by the `kind` discriminator
// (extended in supabase/migrations/0014_software.sql to include
// 'software').

import type { LLMUsage } from '../llm';
import type { ForgeSupabase } from '@/lib/supabase';
import type { Spec, SpecFeedback } from '@/lib/types';
import type { ClassificationResult } from '../classify/classify';
import {
  SoftwareSpecSchema,
  type SoftwareExtractionResult,
  type SoftwareSpec,
} from './spec';

interface PersistArgs {
  supabase: ForgeSupabase;
  specId: string;
  projectId: string;
  result: SoftwareExtractionResult;
  usage: LLMUsage;
  model: string;
  attempts: number;
  feedback: SpecFeedback | null;
  source: 'generate' | 'clarify' | 'refine';
  classification?: ClassificationResult | null;
}

export async function persistSoftwareExtractionResult(
  args: PersistArgs,
): Promise<{ status: 'needs_clarification' | 'awaiting_review' }> {
  const { supabase, result } = args;
  const needsClarification = result.open_questions.length > 0;
  const status: 'needs_clarification' | 'awaiting_review' = needsClarification
    ? 'needs_clarification'
    : 'awaiting_review';

  // Flip kind to 'software' on every software-extractor write. If the
  // user pivoted from agent/system (via the override flow), the
  // discriminator gets corrected here.
  const { error: specErr } = await supabase
    .from('specs')
    .update({
      structured_spec: result.spec as unknown as Spec['structured_spec'],
      open_questions: needsClarification ? result.open_questions : [],
      feedback: (args.feedback ?? null) as unknown as Spec['feedback'],
      kind: 'software',
      status,
    })
    .eq('id', args.specId);
  if (specErr) throw specErr;

  await supabase
    .from('projects')
    .update({ kind: 'software' })
    .eq('id', args.projectId);

  await supabase.from('audit_log').insert({
    project_id: args.projectId,
    action: 'software.draft_generated',
    actor: 'engine.software',
    detail: {
      source: args.source,
      attempts: args.attempts,
      model: args.model,
      usage: args.usage,
      pages: result.spec.pages.length,
      entities: result.spec.entities.length,
      flows: result.spec.flows.length,
      requires_auth: result.spec.auth.requires_auth,
      per_user_isolation: result.spec.auth.per_user_isolation,
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
      action: 'software.clarification_asked',
      actor: 'engine.software',
      detail: {
        questions: result.open_questions,
        usage: args.usage,
        model: args.model,
      },
    });
  }

  return { status };
}

export async function confirmSoftwareSpec(
  supabase: ForgeSupabase,
  spec: Spec,
): Promise<SoftwareSpec> {
  if (!spec.structured_spec) {
    throw new Error('cannot confirm a software spec with no structured_spec');
  }
  // Re-validate at confirm time — catches drift between the schema
  // today and what was persisted earlier.
  const validation = SoftwareSpecSchema.safeParse(spec.structured_spec);
  if (!validation.success) {
    throw new Error('stored SoftwareSpec no longer matches the current schema');
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
    action: 'software.confirmed',
    actor: 'user',
    detail: {
      spec_id: spec.id,
      pages: validation.data.pages.length,
      entities: validation.data.entities.length,
      flows: validation.data.flows.length,
    },
  });

  return validation.data;
}
