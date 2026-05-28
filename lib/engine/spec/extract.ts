// Spec-extraction pipeline.
//
// extractSpec(): raw prompt (+ optional clarification answers / refinements)
//                → validated ExtractionResult { spec, open_questions }
//
// Implements the multi-pass loop described in the engine README:
//   1. Pass 1   → draft + open_questions
//   2. Repair   → ONE retry if the JSON failed validation
//   3. (caller) → if open_questions non-empty, prompt user, then call again
//                  with `answers` (Pass 2) → refined spec
//
// All LLM calls go through lib/engine/llm.ts so usage is captured uniformly.

import {
  LLMError,
  complete,
  sumUsage,
  type GovernanceScope,
  type LLMUsage,
} from '../llm';
import {
  ExtractionResultSchema,
  type ExtractionResult,
} from './schema';
import {
  SPEC_SYSTEM_PROMPT,
  buildExtractionUserMessage,
  buildRepairUserMessage,
} from './prompts';
import { computeAgentConfidence, type SpecConfidence } from './confidence';

export class SpecExtractionError extends Error {
  readonly cause?: unknown;
  readonly raw?: string;
  constructor(message: string, opts?: { cause?: unknown; raw?: string }) {
    super(message);
    this.name = 'SpecExtractionError';
    this.cause = opts?.cause;
    this.raw = opts?.raw;
  }
}

export interface ExtractSpecInput {
  rawPrompt: string;
  answers?: Array<{ question: string; answer: string }>;
  refinements?: string[];
  // Governance scope threaded into every underlying LLM call so the cost
  // ledger attributes spend to the right user + project.
  governance: GovernanceScope;
}

export interface ExtractSpecOutput {
  result: ExtractionResult;
  usage: LLMUsage;
  model: string;
  attempts: number;
  /**
   * Per-top-level-field confidence map. Computed deterministically
   * AFTER extraction (no extra LLM call) by comparing the produced
   * spec against the original intent + schema defaults. Optional
   * so existing test stubs that return canned ExtractSpecOutput
   * objects without this field continue to work. The clarification
   * loop computes it itself when absent.
   */
  confidence?: SpecConfidence;
}

export async function extractSpec(
  input: ExtractSpecInput,
): Promise<ExtractSpecOutput> {
  const userMessage = buildExtractionUserMessage({
    rawPrompt: input.rawPrompt,
    answers: input.answers,
    refinements: input.refinements,
  });

  const govPass1: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'spec.extract') + '.pass1',
  };
  const govRepair: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'spec.extract') + '.repair',
  };

  // --- Pass 1 ---
  const first = await complete({
    system: SPEC_SYSTEM_PROMPT,
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
      confidence: computeAgentConfidence(parsed1.data.spec, input.rawPrompt),
    };
  }

  // --- Repair retry ---
  let repair;
  try {
    repair = await complete({
      system: SPEC_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: first.text },
        { role: 'user', content: buildRepairUserMessage(parsed1.error) },
      ],
      governance: govRepair,
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new SpecExtractionError(
        `Repair attempt failed: ${err.message}`,
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
      confidence: computeAgentConfidence(parsed2.data.spec, input.rawPrompt),
    };
  }

  throw new SpecExtractionError(
    `Could not extract a valid AgentSpec after repair retry. Last validation error: ${parsed2.error}`,
    { raw: repair.text },
  );
}

interface ParseOk {
  ok: true;
  data: ExtractionResult;
}
interface ParseErr {
  ok: false;
  error: string;
}

function tryParseExtraction(text: string): ParseOk | ParseErr {
  const cleaned = stripFences(text).trim();
  if (!cleaned) {
    return { ok: false, error: 'empty response' };
  }

  const sliced = sliceToOuterJsonObject(cleaned);
  if (!sliced) {
    return { ok: false, error: 'no JSON object found in response' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'invalid JSON',
    };
  }

  const validated = ExtractionResultSchema.safeParse(parsed);
  if (!validated.success) {
    // Surface a compact zod error for the repair pass.
    const issues = validated.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
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

// Find the first complete top-level JSON object in `text`. Tolerates a
// preamble before the JSON without giving up on it entirely.
function sliceToOuterJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
