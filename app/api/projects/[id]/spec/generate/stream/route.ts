// Streaming variant of /api/projects/[id]/spec/generate.
//
// Emits SSE phase + log events as the extractor progresses. The final
// state is persisted exactly like the polling route — this is purely a
// progress channel. The UI falls back to the polling route when SSE
// isn't supported.
//
// Phase 2 (Systems) note: this route classifies the intake first, then
// streams either the AgentSpec or the SystemSpec extraction. The
// classification verdict is surfaced as a meta event so the client can
// reflect it in the UI.
//
// SECURITY: this route MUST never stream secrets, tokens, env values, or
// the user's raw prompt back. We only emit phase markers, sanitised log
// lines, and bounded metadata.

import { projectRouteGuard } from '@/lib/route-guard';
import { sseRoute } from '@/lib/stream/sse';
import { NeedsKeyError } from '@/lib/engine/keys';
import { LLMError } from '@/lib/engine/llm';
import { ensureBYOK } from '@/lib/route-needs-key';
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
  const guard = await projectRouteGuard(projectId, { projectedCostUsd: 0.06 });
  if ('error' in guard) {
    return new Response(JSON.stringify(guard.body), {
      status: guard.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const { user } = guard;

  // Pre-flight key gate so an empty-handed user can't even open a
  // stream. ensureBYOK returns a 412 NextResponse we can hand back
  // verbatim; the client's stream-or-poll fallback treats that as a
  // signal to render the NeedsKeyGate.
  const keyBail = await ensureBYOK(user.id, 'anthropic');
  if (keyBail) return keyBail;

  // Optional body — same override semantics as the polling route.
  let bodyParsed: { kind?: string } = {};
  try {
    const raw = await req.text();
    if (raw && raw.trim().length > 0) bodyParsed = JSON.parse(raw) as { kind?: string };
  } catch {
    // ignored — empty/invalid body just means "no override".
  }
  const overrideKind: ClassifiedKind | null =
    typeof bodyParsed.kind === 'string' &&
    (CLASSIFIED_KINDS as readonly string[]).includes(bodyParsed.kind)
      ? (bodyParsed.kind as ClassifiedKind)
      : null;

  return sseRoute(async (ch) => {
    const supabase = getServerSupabase();
    const spec = await loadLatestSpec(supabase, projectId);
    if (!spec) {
      ch.error('project has no spec row', 'not_found');
      return;
    }
    if (spec.status === 'confirmed') {
      ch.error('spec is already confirmed', 'already_done');
      return;
    }

    ch.phase('load', 'ok');
    ch.log('loaded spec row ' + spec.id.slice(0, 8));

    try {
      await markSpecExtracting(supabase, spec.id);

      // --- Classify (or honor an override) ---------------------------
      let kind: ClassifiedKind;
      let classification = null as Awaited<ReturnType<typeof classifyIntake>> | null;
      if (overrideKind) {
        kind = overrideKind;
        ch.log("user-overridden kind: '" + kind + "' (no classifier call)");
      } else if (spec.kind === 'system') {
        kind = 'system';
        ch.log("kind sticky from prior pass: 'system'");
      } else if (spec.kind === 'software') {
        kind = 'software';
        ch.log("kind sticky from prior pass: 'software'");
      } else if (spec.kind === 'infrastructure') {
        kind = 'infrastructure';
        ch.log("kind sticky from prior pass: 'infrastructure'");
      } else if (spec.kind === 'agent' && spec.structured_spec) {
        kind = 'agent';
        ch.log("kind sticky from prior pass: 'agent'");
      } else {
        ch.phase('classify', 'started');
        classification = await classifyIntake({
          rawPrompt: spec.raw_prompt,
          governance: {
            user_id: user.id,
            project_id: projectId,
            ref: 'spec.generate.stream.' + spec.id,
          },
        });
        kind = classification.kind;
        ch.phase('classify', 'ok');
        ch.meta({
          classified_kind: classification.kind,
          confidence: classification.confidence,
          // 'why' is short and bounded by the classifier prompt; safe to
          // surface as a meta crumb.
          why: classification.why,
        });
      }

      ch.phase('pass1', 'started');
      ch.log(
        'asking the planner-grade model for a draft ' +
          (kind === 'system'
            ? 'SystemSpec'
            : kind === 'software'
              ? 'SoftwareSpec'
              : kind === 'infrastructure'
                ? 'InfraSpec'
                : 'AgentSpec'),
      );

      if (kind === 'infrastructure') {
        const { result, usage, model, attempts } = await extractInfraSpec({
          rawPrompt: spec.raw_prompt,
          governance: {
            user_id: user.id,
            project_id: projectId,
            ref: 'infra.generate.stream.' + spec.id,
          },
        });
        ch.phase('pass1', 'ok');
        ch.meta({
          attempts,
          model,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          resources: result.spec.resources.length,
          topology_edges: result.spec.topology.length,
          lifecycle: result.spec.lifecycle,
          open_questions: result.open_questions.length,
        });

        ch.phase('persist', 'started');
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
        ch.phase('persist', 'ok');
        ch.done({
          status,
          kind: 'infrastructure',
          open_questions: result.open_questions,
        });
        return;
      }

      if (kind === 'software') {
        const { result, usage, model, attempts } = await extractSoftwareSpec({
          rawPrompt: spec.raw_prompt,
          governance: {
            user_id: user.id,
            project_id: projectId,
            ref: 'software.generate.stream.' + spec.id,
          },
        });
        ch.phase('pass1', 'ok');
        ch.meta({
          attempts,
          model,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          pages: result.spec.pages.length,
          entities: result.spec.entities.length,
          flows: result.spec.flows.length,
          requires_auth: result.spec.auth.requires_auth,
          per_user_isolation: result.spec.auth.per_user_isolation,
          open_questions: result.open_questions.length,
        });

        ch.phase('persist', 'started');
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
        ch.phase('persist', 'ok');
        ch.done({
          status,
          kind: 'software',
          open_questions: result.open_questions,
        });
        return;
      }

      if (kind === 'system') {
        const { result, usage, model, attempts } = await extractSystemSpec({
          rawPrompt: spec.raw_prompt,
          governance: {
            user_id: user.id,
            project_id: projectId,
            ref: 'system.generate.stream.' + spec.id,
          },
        });
        ch.phase('pass1', 'ok');
        ch.meta({
          attempts,
          model,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          sub_agents: result.spec.sub_agents.length,
          coordination: result.spec.coordination.pattern,
          max_steps: result.spec.max_steps,
          open_questions: result.open_questions.length,
        });

        ch.phase('persist', 'started');
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
        ch.phase('persist', 'ok');
        ch.done({
          status,
          kind: 'system',
          open_questions: result.open_questions,
        });
        return;
      }

      // kind === 'agent' — unchanged Phase 1 flow.
      const { result, usage, model, attempts } = await extractSpec({
        rawPrompt: spec.raw_prompt,
        governance: {
          user_id: user.id,
          project_id: projectId,
          ref: 'spec.generate.stream.' + spec.id,
        },
      });
      ch.phase('pass1', 'ok');
      ch.meta({
        attempts,
        model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        confidence: result.spec.confidence,
        open_questions: result.open_questions.length,
      });

      ch.phase('persist', 'started');
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
      ch.phase('persist', 'ok');
      ch.done({
        status,
        kind: 'agent',
        open_questions: result.open_questions,
      });
    } catch (err) {
      if (err instanceof NeedsKeyError) {
        ch.error(
          'connect your ' + err.provider + ' key to continue',
          'needs_key:' + err.provider,
        );
        return;
      }
      const message = describeError(err);
      try {
        await markSpecFailed(supabase, spec.id, projectId, message);
      } catch {
        // swallow — we still want to surface the original failure
      }
      ch.phase('pass1', 'failed');
      ch.error(message);
    }
  });
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
