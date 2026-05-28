// InfraSpec extraction pipeline.
//
// extractInfraSpec(): raw prompt (+ optional clarification answers /
//                     refinements) → validated InfraExtractionResult.
//
// Same two-pass shape as the agent + system + software extractors (see
// lib/engine/spec/extract.ts and lib/engine/software/extract.ts):
// pass1 → if invalid, ONE repair retry → otherwise the caller surfaces
// open_questions / fails.
//
// All LLM calls flow through lib/engine/llm.ts so cost recording +
// governance happen uniformly across all four kinds.

import {
  LLMError,
  complete,
  sumUsage,
  type GovernanceScope,
  type LLMUsage,
} from '../llm';
import { modelForTask } from '../model-policy';
import {
  InfraExtractionResultSchema,
  type InfraExtractionResult,
} from './spec';
import {
  INFRA_SPEC_SYSTEM_PROMPT,
  buildInfraExtractionUserMessage,
  buildInfraRepairUserMessage,
} from './prompts';
import {
  computeInfraConfidence,
  type SpecConfidence,
} from '../spec/confidence';

export class InfraExtractionError extends Error {
  readonly cause?: unknown;
  readonly raw?: string;
  constructor(message: string, opts?: { cause?: unknown; raw?: string }) {
    super(message);
    this.name = 'InfraExtractionError';
    this.cause = opts?.cause;
    this.raw = opts?.raw;
  }
}

export interface ExtractInfraSpecInput {
  rawPrompt: string;
  answers?: Array<{ question: string; answer: string }>;
  refinements?: string[];
  governance: GovernanceScope;
}

export interface ExtractInfraSpecOutput {
  result: InfraExtractionResult;
  usage: LLMUsage;
  model: string;
  attempts: number;
  /** Optional per-field confidence map; see lib/engine/spec/confidence.ts. */
  confidence?: SpecConfidence;
}

export async function extractInfraSpec(
  input: ExtractInfraSpecInput,
): Promise<ExtractInfraSpecOutput> {
  const userMessage = buildInfraExtractionUserMessage({
    rawPrompt: input.rawPrompt,
    answers: input.answers,
    refinements: input.refinements,
  });

  const govPass1: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'infra.extract') + '.pass1',
  };
  const govRepair: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'infra.extract') + '.repair',
  };

  // --- Pass 1 ---
  const first = await complete({
    model: modelForTask('extract'),
    system: INFRA_SPEC_SYSTEM_PROMPT,
    // Stable, deterministic system prefix above the cache minimum —
    // cache it (5-min ephemeral) so repair / re-extraction read it back
    // at 0.1x. Variable intent stays in the user message.
    cacheSystem: true,
    messages: [{ role: 'user', content: userMessage }],
    governance: govPass1,
  });

  const parsed1 = tryParseExtraction(first.text);
  if (parsed1.ok) {
    return {
      result: parsed1.data,
      usage: first.usage,
      model: first.model,
      attempts: 1,
      confidence: computeInfraConfidence(parsed1.data.spec, input.rawPrompt),
    };
  }

  // --- Repair retry ---
  let repair;
  try {
    repair = await complete({
      model: modelForTask('extract'),
      system: INFRA_SPEC_SYSTEM_PROMPT,
      cacheSystem: true,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: first.text },
        { role: 'user', content: buildInfraRepairUserMessage(parsed1.error) },
      ],
      governance: govRepair,
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new InfraExtractionError(
        'Repair attempt failed: ' + err.message,
        { cause: err, raw: first.text },
      );
    }
    throw err;
  }

  const parsed2 = tryParseExtraction(repair.text);
  const totalUsage = sumUsage(first.usage, repair.usage);

  if (parsed2.ok) {
    return {
      result: parsed2.data,
      usage: totalUsage,
      model: repair.model,
      attempts: 2,
      confidence: computeInfraConfidence(parsed2.data.spec, input.rawPrompt),
    };
  }

  throw new InfraExtractionError(
    'Could not extract a valid InfraSpec after repair retry. Last validation error: ' +
      parsed2.error,
    { raw: repair.text },
  );
}

interface ParseOk { ok: true; data: InfraExtractionResult; }
interface ParseErr { ok: false; error: string; }

function tryParseExtraction(text: string): ParseOk | ParseErr {
  const cleaned = stripFences(text).trim();
  if (!cleaned) return { ok: false, error: 'empty response' };

  const sliced = sliceToOuterJsonObject(cleaned);
  if (!sliced) return { ok: false, error: 'no JSON object found in response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' };
  }

  const validated = InfraExtractionResultSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 6)
      .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
      .join('; ');
    return { ok: false, error: issues };
  }
  return { ok: true, data: validated.data };
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json|JSON)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
  }
  return trimmed;
}

function sliceToOuterJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
