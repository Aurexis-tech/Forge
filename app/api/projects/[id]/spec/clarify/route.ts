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
  answers: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(400),
        answer: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(3),
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

  // Friendly key-gate: bail with 412 BEFORE burning anything if the
  // user hasn't connected an Anthropic key (and REQUIRE_BYOK is on).
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
  if (spec.status !== 'needs_clarification') {
    return NextResponse.json(
      { error: `spec is in status '${spec.status}', not 'needs_clarification'` },
      { status: 409 },
    );
  }

  const merged = mergeFeedback(spec.feedback ?? null, {
    answers: parsed.data.answers,
  } satisfies SpecFeedback);

  try {
    await markSpecExtracting(supabase, spec.id);

    // Phase 2: branch on the spec's `kind` discriminator. System specs
    // were classified at generate-time; clarify reuses the same kind so
    // we don't fight the user's earlier intent.
    if (spec.kind === 'system') {
      const { result, usage, model, attempts } = await extractSystemSpec({
        rawPrompt: spec.raw_prompt,
        answers: merged.answers,
        refinements: merged.refinements,
        governance: { user_id: user.id, project_id: projectId, ref: 'system.clarify' },
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
        source: 'clarify',
      });
      return NextResponse.json({
        status,
        kind: 'system',
        spec: result.spec,
        open_questions: result.open_questions,
      });
    }

    const { result, usage, model, attempts } = await extractSpec({
      rawPrompt: spec.raw_prompt,
      answers: merged.answers,
      refinements: merged.refinements,
      governance: { user_id: user.id, project_id: projectId, ref: 'spec.clarify' },
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
      source: 'clarify',
    });

    return NextResponse.json({
      status,
      kind: 'agent',
      spec: result.spec,
      open_questions: result.open_questions,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Don't mark the spec failed — nothing went wrong with extraction.
      // Reset back to needs_clarification so the user can retry after
      // connecting their key.
      await supabase
        .from('specs')
        .update({ status: 'needs_clarification' })
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
  if (err instanceof LLMError) return `LLM error: ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'unknown spec extraction error';
}
