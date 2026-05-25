import { NextResponse } from 'next/server';
import { z } from 'zod';
import { projectRouteGuard } from '@/lib/route-guard';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import { getServerSupabase } from '@/lib/supabase';
import { NeedsKeyError } from '@/lib/engine/keys';
import { extractSpec, SpecExtractionError } from '@/lib/engine/spec/extract';
import {
  extractSystemSpec,
  SystemExtractionError,
} from '@/lib/engine/system/extract';
import { persistSystemExtractionResult } from '@/lib/engine/system/persistence';
import {
  extractSoftwareSpec,
  SoftwareExtractionError,
} from '@/lib/engine/software/extract';
import { persistSoftwareExtractionResult } from '@/lib/engine/software/persistence';
import {
  extractInfraSpec,
  InfraExtractionError,
} from '@/lib/engine/infra/extract';
import { persistInfraExtractionResult } from '@/lib/engine/infra/persistence';
import { LLMError } from '@/lib/engine/llm';
import {
  loadLatestSpec,
  markSpecExtracting,
  markSpecFailed,
  mergeFeedback,
  persistExtractionResult,
} from '@/lib/engine/spec/persistence';
import type { SpecFeedback } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

const BodySchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;

  const guard = await projectRouteGuard(projectId, { projectedCostUsd: 0.05 });
  if ('error' in guard) {
    return NextResponse.json(guard.body, { status: guard.status });
  }
  const { user } = guard;

  // Pre-flight key gate — bail with 412 if Anthropic isn't connected.
  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }

  const supabase = getServerSupabase();
  const spec = await loadLatestSpec(supabase, projectId);
  if (!spec) {
    return NextResponse.json({ error: 'project has no spec row' }, { status: 404 });
  }
  if (spec.status === 'confirmed') {
    return NextResponse.json(
      { error: 'spec is already confirmed; cannot refine' },
      { status: 409 },
    );
  }

  const merged = mergeFeedback(spec.feedback ?? null, {
    refinements: [parsed.data.note],
  } satisfies SpecFeedback);

  try {
    await markSpecExtracting(supabase, spec.id);

    // Phase 2/3/4: branch on the spec's `kind` discriminator. A refine
    // never re-classifies — the kind is sticky from generate-time.
    if (spec.kind === 'infrastructure') {
      const { result, usage, model, attempts } = await extractInfraSpec({
        governance: { user_id: user.id, project_id: projectId, ref: 'infra.refine' },
        rawPrompt: spec.raw_prompt,
        answers: merged.answers,
        refinements: merged.refinements,
      });
      const { status } = await persistInfraExtractionResult({
        supabase,
        specId: spec.id,
        projectId,
        result,
        usage,
        model,
        attempts,
        feedback: merged,
        source: 'refine',
      });
      return NextResponse.json({
        status,
        kind: 'infrastructure',
        spec: result.spec,
        open_questions: result.open_questions,
      });
    }

    if (spec.kind === 'software') {
      const { result, usage, model, attempts } = await extractSoftwareSpec({
        governance: { user_id: user.id, project_id: projectId, ref: 'software.refine' },
        rawPrompt: spec.raw_prompt,
        answers: merged.answers,
        refinements: merged.refinements,
      });
      const { status } = await persistSoftwareExtractionResult({
        supabase,
        specId: spec.id,
        projectId,
        result,
        usage,
        model,
        attempts,
        feedback: merged,
        source: 'refine',
      });
      return NextResponse.json({
        status,
        kind: 'software',
        spec: result.spec,
        open_questions: result.open_questions,
      });
    }

    if (spec.kind === 'system') {
      const { result, usage, model, attempts } = await extractSystemSpec({
        governance: { user_id: user.id, project_id: projectId, ref: 'system.refine' },
        rawPrompt: spec.raw_prompt,
        answers: merged.answers,
        refinements: merged.refinements,
      });
      const { status } = await persistSystemExtractionResult({
        supabase,
        specId: spec.id,
        projectId,
        result,
        usage,
        model,
        attempts,
        feedback: merged,
        source: 'refine',
      });
      return NextResponse.json({
        status,
        kind: 'system',
        spec: result.spec,
        open_questions: result.open_questions,
      });
    }

    const { result, usage, model, attempts } = await extractSpec({
      governance: { user_id: user.id, project_id: projectId, ref: 'spec.refine' },
      rawPrompt: spec.raw_prompt,
      answers: merged.answers,
      refinements: merged.refinements,
    });

    const { status } = await persistExtractionResult({
      supabase,
      specId: spec.id,
      projectId,
      result,
      usage,
      model,
      attempts,
      feedback: merged,
      source: 'refine',
    });

    return NextResponse.json({
      status,
      kind: 'agent',
      spec: result.spec,
      open_questions: result.open_questions,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Spec was already in awaiting_review before refine; revert there
      // so the user can retry after connecting their key.
      await supabase
        .from('specs')
        .update({ status: 'awaiting_review' })
        .eq('id', spec.id);
      return needsKeyResponse(err)!;
    }
    const message = describeError(err);
    await markSpecFailed(supabase, spec.id, projectId, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function describeError(err: unknown): string {
  if (err instanceof SpecExtractionError) return err.message;
  if (err instanceof SystemExtractionError) return err.message;
  if (err instanceof SoftwareExtractionError) return err.message;
  if (err instanceof InfraExtractionError) return err.message;
  if (err instanceof LLMError) return `LLM error: ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'unknown spec extraction error';
}
