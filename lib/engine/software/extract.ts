// SoftwareSpec extraction pipeline.
//
// extractSoftwareSpec(): raw prompt (+ optional clarification answers /
//                       refinements) → validated SoftwareExtractionResult.
//
// Same two-pass shape as the agent + system extractors (see
// lib/engine/spec/extract.ts and lib/engine/system/extract.ts): pass1 →
// if invalid, ONE repair retry → otherwise the caller surfaces
// open_questions / fails.
//
// All LLM calls flow through lib/engine/llm.ts so cost recording +
// governance happen uniformly across all three kinds.

import {
  LLMError,
  complete,
  sumUsage,
  type GovernanceScope,
  type LLMUsage,
} from '../llm';
import { modelForTask } from '../model-policy';
import {
  SoftwareExtractionResultSchema,
  type SoftwareExtractionResult,
} from './spec';
import {
  SOFTWARE_SPEC_SYSTEM_PROMPT,
  buildSoftwareExtractionUserMessage,
  buildSoftwareRepairUserMessage,
} from './prompts';
import {
  computeSoftwareConfidence,
  type SpecConfidence,
} from '../spec/confidence';

export class SoftwareExtractionError extends Error {
  readonly cause?: unknown;
  readonly raw?: string;
  constructor(message: string, opts?: { cause?: unknown; raw?: string }) {
    super(message);
    this.name = 'SoftwareExtractionError';
    this.cause = opts?.cause;
    this.raw = opts?.raw;
  }
}

export interface ExtractSoftwareSpecInput {
  rawPrompt: string;
  answers?: Array<{ question: string; answer: string }>;
  refinements?: string[];
  governance: GovernanceScope;
}

export interface ExtractSoftwareSpecOutput {
  result: SoftwareExtractionResult;
  usage: LLMUsage;
  model: string;
  attempts: number;
  /** Optional per-field confidence map; see lib/engine/spec/confidence.ts. */
  confidence?: SpecConfidence;
}

export async function extractSoftwareSpec(
  input: ExtractSoftwareSpecInput,
): Promise<ExtractSoftwareSpecOutput> {
  const userMessage = buildSoftwareExtractionUserMessage({
    rawPrompt: input.rawPrompt,
    answers: input.answers,
    refinements: input.refinements,
  });

  const govPass1: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'software.extract') + '.pass1',
  };
  const govRepair: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'software.extract') + '.repair',
  };

  // --- Pass 1 ---
  const first = await complete({
    model: modelForTask('extract'),
    system: SOFTWARE_SPEC_SYSTEM_PROMPT,
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
      confidence: computeSoftwareConfidence(parsed1.data.spec, input.rawPrompt),
    };
  }

  // --- Repair retry ---
  let repair;
  try {
    repair = await complete({
      model: modelForTask('extract'),
      system: SOFTWARE_SPEC_SYSTEM_PROMPT,
      cacheSystem: true,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: first.text },
        { role: 'user', content: buildSoftwareRepairUserMessage(parsed1.error) },
      ],
      governance: govRepair,
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new SoftwareExtractionError(
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
      confidence: computeSoftwareConfidence(parsed2.data.spec, input.rawPrompt),
    };
  }

  throw new SoftwareExtractionError(
    'Could not extract a valid SoftwareSpec after repair retry. Last validation error: ' +
      parsed2.error,
    { raw: repair.text },
  );
}

interface ParseOk { ok: true; data: SoftwareExtractionResult; }
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

  const validated = SoftwareExtractionResultSchema.safeParse(parsed);
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
