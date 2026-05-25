import { NextResponse } from 'next/server';
import { requireProjectOwnership, requireUser, UnauthorizedError } from '@/lib/auth';
import {
  assertAllowed,
  GovernanceError,
  governanceBlockResponse,
} from '@/lib/engine/governance/guard';
import { LLMError } from '@/lib/engine/llm';
import { NeedsKeyError } from '@/lib/engine/keys';
import { ensureBYOK, needsKeyResponse } from '@/lib/route-needs-key';
import {
  CLASSIFIED_KINDS,
  classifyIntake,
  type ClassifiedKind,
} from '@/lib/engine/classify/classify';
import { extractSpec, SpecExtractionError } from '@/lib/engine/spec/extract';
import {
  loadLatestSpec,
  markSpecExtracting,
  markSpecFailed,
  persistExtractionResult,
} from '@/lib/engine/spec/persistence';
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
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;

  // Auth + ownership.
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }
  const ownership = await requireProjectOwnership(projectId, user);
  if ('error' in ownership) {
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
  }

  // Pre-flight key gate — bail with 412 if Anthropic isn't connected.
  // Cheaper than burning the classifier call only to fail at extraction.
  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  // Governance gate at route entry. The llm.complete wrapper guards
  // again before each individual call — this earlier check just fails
  // fast. Budget covers classifier (cheap) + extractor (2 passes).
  try {
    await assertAllowed({
      user_id: user.id,
      project_id: projectId,
      projectedCostUsd: 0.06,
    });
  } catch (err) {
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      return NextResponse.json(body, { status });
    }
    throw err;
  }

  // Optional body — accepts an explicit kind override so the user can
  // force a re-classification ("this is actually a multi-agent system"
  // / "no, this is a single agent"). Body is optional; missing body is
  // fine, the classifier picks.
  let bodyParsed: { kind?: string } = {};
  try {
    const raw = await req.text();
    if (raw && raw.trim().length > 0) bodyParsed = JSON.parse(raw) as { kind?: string };
  } catch {
    // Treat unparseable body as "no override" — don't 400 the caller
    // for the common case of an empty POST.
  }
  const overrideKind: ClassifiedKind | null =
    typeof bodyParsed.kind === 'string' &&
    (CLASSIFIED_KINDS as readonly string[]).includes(bodyParsed.kind)
      ? (bodyParsed.kind as ClassifiedKind)
      : null;

  const supabase = getServerSupabase();
  const spec = await loadLatestSpec(supabase, projectId);
  if (!spec) {
    return NextResponse.json({ error: 'project has no spec row' }, { status: 404 });
  }
  if (spec.status === 'confirmed') {
    return NextResponse.json(
      { error: 'spec is already confirmed; cannot regenerate' },
      { status: 409 },
    );
  }

  try {
    await markSpecExtracting(supabase, spec.id);

    // --- Decide kind ---------------------------------------------------
    // Order: explicit override > existing sticky kind on the spec > LLM
    // classifier. The classifier defaults to 'agent' if its output is
    // unparseable. With Phase 4 the classifier returns one of
    // 'agent' | 'system' | 'software' | 'infrastructure'.
    let kind: ClassifiedKind;
    let classification = null as Awaited<ReturnType<typeof classifyIntake>> | null;
    if (overrideKind) {
      kind = overrideKind;
    } else if (spec.kind === 'system') {
      kind = 'system';
    } else if (spec.kind === 'software') {
      kind = 'software';
    } else if (spec.kind === 'infrastructure') {
      kind = 'infrastructure';
    } else if (spec.kind === 'agent' && spec.structured_spec) {
      // The user has already taken this spec down the agent path at
      // least once (there's a draft on the row). Stay on the agent path
      // — don't burn a classifier call.
      kind = 'agent';
    } else {
      classification = await classifyIntake({
        rawPrompt: spec.raw_prompt,
        governance: {
          user_id: user.id,
          project_id: projectId,
          ref: 'spec.generate.' + spec.id,
        },
      });
      kind = classification.kind;
    }

    // --- Route to the right extractor ---------------------------------
    if (kind === 'infrastructure') {
      const { result, usage, model, attempts } = await extractInfraSpec({
        rawPrompt: spec.raw_prompt,
        governance: {
          user_id: user.id,
          project_id: projectId,
          ref: 'infra.generate.' + spec.id,
        },
      });
      const { status } = await persistInfraExtractionResult({
        supabase,
        specId: spec.id,
        projectId,
        result,
        usage,
        model,
        attempts,
        feedback: null,
        source: 'generate',
        classification,
      });
      return NextResponse.json({
        status,
        kind: 'infrastructure',
        spec: result.spec,
        open_questions: result.open_questions,
        classification: classification
          ? {
              kind: classification.kind,
              confidence: classification.confidence,
              why: classification.why,
            }
          : null,
      });
    }

    if (kind === 'software') {
      const { result, usage, model, attempts } = await extractSoftwareSpec({
        rawPrompt: spec.raw_prompt,
        governance: {
          user_id: user.id,
          project_id: projectId,
          ref: 'software.generate.' + spec.id,
        },
      });
      const { status } = await persistSoftwareExtractionResult({
        supabase,
        specId: spec.id,
        projectId,
        result,
        usage,
        model,
        attempts,
        feedback: null,
        source: 'generate',
        classification,
      });
      return NextResponse.json({
        status,
        kind: 'software',
        spec: result.spec,
        open_questions: result.open_questions,
        classification: classification
          ? {
              kind: classification.kind,
              confidence: classification.confidence,
              why: classification.why,
            }
          : null,
      });
    }

    if (kind === 'system') {
      const { result, usage, model, attempts } = await extractSystemSpec({
        rawPrompt: spec.raw_prompt,
        governance: {
          user_id: user.id,
          project_id: projectId,
          ref: 'system.generate.' + spec.id,
        },
      });
      const { status } = await persistSystemExtractionResult({
        supabase,
        specId: spec.id,
        projectId,
        result,
        usage,
        model,
        attempts,
        feedback: null,
        source: 'generate',
        classification,
      });
      return NextResponse.json({
        status,
        kind: 'system',
        spec: result.spec,
        open_questions: result.open_questions,
        classification: classification
          ? {
              kind: classification.kind,
              confidence: classification.confidence,
              why: classification.why,
            }
          : null,
      });
    }

    // kind === 'agent' — original Phase 1 flow, untouched.
    const { result, usage, model, attempts } = await extractSpec({
      rawPrompt: spec.raw_prompt,
      governance: {
        user_id: user.id,
        project_id: projectId,
        ref: 'spec.generate.' + spec.id,
      },
    });

    const { status } = await persistExtractionResult({
      supabase,
      specId: spec.id,
      projectId,
      result,
      usage,
      model,
      attempts,
      feedback: null,
      source: 'generate',
    });

    return NextResponse.json({
      status,
      kind: 'agent',
      spec: result.spec,
      open_questions: result.open_questions,
      classification: classification
        ? {
            kind: classification.kind,
            confidence: classification.confidence,
            why: classification.why,
          }
        : null,
    });
  } catch (err) {
    // NeedsKey is a UX state, not an error — don't mark the spec failed.
    if (err instanceof NeedsKeyError) {
      const r = needsKeyResponse(err);
      await supabase.from('specs').update({ status: 'pending' }).eq('id', spec.id);
      return r!;
    }
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      await markSpecFailed(supabase, spec.id, projectId, body.error);
      return NextResponse.json(body, { status });
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
  if (err instanceof LLMError) return 'LLM error: ' + err.message;
  if (err instanceof Error) return err.message;
  return 'unknown spec extraction error';
}
