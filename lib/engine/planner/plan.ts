// Planner pipeline.
//
//   plan(): confirmed AgentSpec (+ optional refinements)
//           → validated BuildPlan
//
// Steps:
//   1. Pass 1 — LLM produces a BuildPlan JSON
//   2. Validate against the Zod schema AND the DAG / registry checks
//   3. If invalid, ONE repair retry with the error fed back
//   4. If still invalid, throw a clean PlanError the route can surface
//
// All LLM calls go through lib/engine/llm.ts so usage is captured.

import {
  LLMError,
  complete,
  sumUsage,
  type GovernanceScope,
  type LLMUsage,
} from '../llm';
import { modelForTask } from '../model-policy';
import type { AgentSpec } from '../spec/schema';
import {
  BuildPlanSchema,
  type BuildPlan,
  issuesToErrorString,
  validatePlanTools,
  validateTaskGraph,
} from './schema';
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerRepairMessage,
  buildPlannerUserMessage,
} from './prompts';

export class PlanError extends Error {
  readonly cause?: unknown;
  readonly raw?: string;
  constructor(message: string, opts?: { cause?: unknown; raw?: string }) {
    super(message);
    this.name = 'PlanError';
    this.cause = opts?.cause;
    this.raw = opts?.raw;
  }
}

export interface PlanInput {
  spec: AgentSpec;
  refinements?: string[];
  governance: GovernanceScope;
}

export interface PlanOutput {
  plan: BuildPlan;
  usage: LLMUsage;
  model: string;
  attempts: number;
}

export async function plan(input: PlanInput): Promise<PlanOutput> {
  const userMessage = buildPlannerUserMessage({
    spec: input.spec,
    refinements: input.refinements,
  });

  const govPass1: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'plan') + '.pass1',
  };
  const govRepair: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'plan') + '.repair',
  };

  // --- Pass 1 ---
  const first = await complete({
    model: modelForTask('plan'),
    system: PLANNER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 4000,
    governance: govPass1,
  });

  const parsed1 = tryParseAndValidate(first.text);
  if (parsed1.ok) {
    return {
      plan: parsed1.data,
      usage: first.usage,
      model: first.model,
      attempts: 1,
    };
  }

  // --- Repair retry ---
  let repair;
  try {
    repair = await complete({
      model: modelForTask('plan'),
      system: PLANNER_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: first.text },
        { role: 'user', content: buildPlannerRepairMessage(parsed1.error) },
      ],
      maxTokens: 4000,
      governance: govRepair,
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new PlanError(`Repair attempt failed: ${err.message}`, {
        cause: err,
        raw: first.text,
      });
    }
    throw err;
  }

  const parsed2 = tryParseAndValidate(repair.text);
  const totalUsage = sumUsage(first.usage, repair.usage);

  if (parsed2.ok) {
    return {
      plan: parsed2.data,
      usage: totalUsage,
      model: repair.model,
      attempts: 2,
    };
  }

  throw new PlanError(
    `Could not produce a valid BuildPlan after repair retry. Last validation error: ${parsed2.error}`,
    { raw: repair.text },
  );
}

// --- Parsing + validation --------------------------------------------------

interface ParseOk { ok: true; data: BuildPlan; }
interface ParseErr { ok: false; error: string; }

function tryParseAndValidate(text: string): ParseOk | ParseErr {
  const cleaned = stripFences(text).trim();
  if (!cleaned) return { ok: false, error: 'empty response' };

  const sliced = sliceToOuterJsonObject(cleaned);
  if (!sliced) return { ok: false, error: 'no JSON object found in response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'invalid JSON',
    };
  }

  const schemaCheck = BuildPlanSchema.safeParse(parsed);
  if (!schemaCheck.success) {
    const issues = schemaCheck.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `schema: ${issues}` };
  }

  const dagIssues = validateTaskGraph(schemaCheck.data.tasks);
  const toolIssues = validatePlanTools(schemaCheck.data);
  if (dagIssues.length > 0 || toolIssues.length > 0) {
    return {
      ok: false,
      error: issuesToErrorString(dagIssues, toolIssues),
    };
  }

  return { ok: true, data: schemaCheck.data };
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

// Convenience for routes that want a single coverage summary in the audit log.
export function summariseToolCoverage(buildPlan: BuildPlan): {
  supported: number;
  needs_key: number;
  unsupported: number;
} {
  let supported = 0;
  let needs_key = 0;
  let unsupported = 0;
  for (const t of buildPlan.tools) {
    if (t.status === 'supported') supported++;
    else if (t.status === 'needs_key') needs_key++;
    else unsupported++;
  }
  return { supported, needs_key, unsupported };
}
