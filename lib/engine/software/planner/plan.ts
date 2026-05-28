// Phase 3 software build planner pipeline.
//
//   planSoftware(): confirmed SoftwareSpec (+ optional refinements)
//                  → validated SoftwareBuildPlan
//
// Flow:
//   1. Derive base task DAG from spec + template (deterministic, no LLM)
//   2. Run the REUSED Phase 1 task-graph validator inside graph.ts
//      (Kahn topo + cycle + dup + unknown-dep detection)
//   3. Light LLM pass (sonnet) — fills in per-task descriptions and
//      surfaces warnings; ONE repair retry on validation failure
//   4. Stitch LLM output onto the deterministic graph, validate the
//      assembled plan against SoftwareBuildPlanSchema
//
// All LLM calls flow through lib/engine/llm.complete so cost recording
// + governance + BYOK key resolution are inherited from Phase 1.

import { z } from 'zod';
import {
  LLMError,
  complete,
  sumUsage,
  type GovernanceScope,
  type LLMUsage,
} from '@/lib/engine/llm';
import { modelForTask } from '@/lib/engine/model-policy';
import type { SoftwareSpec } from '../spec';
import {
  SoftwareGraphError,
  deriveSoftwareGraph,
  type SoftwareDerivedGraph,
  type SoftwareDerivedTask,
} from './graph';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
  type SoftwareTask,
} from './schema';
import {
  SOFTWARE_PLANNER_SYSTEM_PROMPT,
  buildSoftwarePlannerRepairMessage,
  buildSoftwarePlannerUserMessage,
} from './prompts';
import { TEMPLATE_ID } from './template';

export class SoftwarePlanError extends Error {
  readonly cause?: unknown;
  readonly raw?: string;
  constructor(message: string, opts?: { cause?: unknown; raw?: string }) {
    super(message);
    this.name = 'SoftwarePlanError';
    this.cause = opts?.cause;
    this.raw = opts?.raw;
  }
}

export interface PlanSoftwareInput {
  spec: SoftwareSpec;
  refinements?: string[];
  governance: GovernanceScope;
}

export interface PlanSoftwareOutput {
  plan: SoftwareBuildPlan;
  usage: LLMUsage;
  model: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Entry point. Graph rejections throw with a clear message the caller
// can surface verbatim; LLM-stage rejections retry once.
// ---------------------------------------------------------------------------
export async function planSoftware(
  input: PlanSoftwareInput,
): Promise<PlanSoftwareOutput> {
  // --- 1 + 2. Derive + validate the graph (deterministic, no LLM) -------
  let graph: SoftwareDerivedGraph;
  try {
    graph = deriveSoftwareGraph(input.spec);
  } catch (err) {
    if (err instanceof SoftwareGraphError) {
      throw new SoftwarePlanError(err.message, { cause: err });
    }
    throw err;
  }

  const userMessage = buildSoftwarePlannerUserMessage({
    spec: input.spec,
    graph,
    refinements: input.refinements,
  });

  const govPass1: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'software.plan') + '.pass1',
  };
  const govRepair: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'software.plan') + '.repair',
  };

  // --- 3. Light LLM detail pass -----------------------------------------
  const first = await complete({
    model: modelForTask('plan'),
    system: SOFTWARE_PLANNER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 3000,
    governance: govPass1,
  });

  const stitched1 = stitchAndValidate(first.text, graph);
  if (stitched1.ok) {
    return {
      plan: stitched1.data,
      usage: first.usage,
      model: first.model,
      attempts: 1,
    };
  }

  // --- Repair retry -----------------------------------------------------
  let repair;
  try {
    repair = await complete({
      model: modelForTask('plan'),
      system: SOFTWARE_PLANNER_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: first.text },
        { role: 'user', content: buildSoftwarePlannerRepairMessage(stitched1.error) },
      ],
      maxTokens: 3000,
      governance: govRepair,
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new SoftwarePlanError('Repair attempt failed: ' + err.message, {
        cause: err,
        raw: first.text,
      });
    }
    throw err;
  }

  const stitched2 = stitchAndValidate(repair.text, graph);
  const totalUsage = sumUsage(first.usage, repair.usage);

  if (stitched2.ok) {
    return {
      plan: stitched2.data,
      usage: totalUsage,
      model: repair.model,
      attempts: 2,
    };
  }

  throw new SoftwarePlanError(
    'Could not produce a valid SoftwareBuildPlan after repair retry. Last validation error: ' +
      stitched2.error,
    { raw: repair.text },
  );
}

// ---------------------------------------------------------------------------
// LLM-output schema (the narrow per-task enrichment surface).
// ---------------------------------------------------------------------------
const LlmTaskDetailSchema = z.object({
  id: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(800),
});
const LlmDetailSchema = z.object({
  tasks: z.array(LlmTaskDetailSchema).min(1).max(80),
  warnings: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
});

interface StitchOk { ok: true; data: SoftwareBuildPlan; }
interface StitchErr { ok: false; error: string; }

function stitchAndValidate(
  text: string,
  graph: SoftwareDerivedGraph,
): StitchOk | StitchErr {
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

  const detail = LlmDetailSchema.safeParse(parsed);
  if (!detail.success) {
    const issues = detail.error.issues
      .slice(0, 6)
      .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
      .join('; ');
    return { ok: false, error: 'detail schema: ' + issues };
  }

  // Every task id from the graph must appear exactly once in the LLM output.
  const detailById = new Map<string, z.infer<typeof LlmTaskDetailSchema>>();
  for (const t of detail.data.tasks) detailById.set(t.id, t);
  for (const t of graph.tasks) {
    if (!detailById.has(t.id)) {
      return { ok: false, error: "LLM detail missing task '" + t.id + "'" };
    }
  }
  for (const t of detail.data.tasks) {
    if (!graph.tasks.some((g) => g.id === t.id)) {
      return { ok: false, error: "LLM detail introduced unknown task '" + t.id + "'" };
    }
  }

  // Stitch — keep the deterministic graph as the source of truth for
  // layer / slot / depends_on / files; only the description is taken
  // from the LLM.
  const stitched: SoftwareTask[] = graph.tasks.map((t: SoftwareDerivedTask) => ({
    id: t.id,
    layer: t.layer,
    description: detailById.get(t.id)?.description ?? t.description,
    depends_on: t.depends_on,
    slot: t.slot,
    files: t.files,
  }));

  const planCandidate = {
    template_id: TEMPLATE_ID,
    tasks: stitched,
    execution_order: graph.executionOrder,
    warnings: detail.data.warnings,
  };

  const final = SoftwareBuildPlanSchema.safeParse(planCandidate);
  if (!final.success) {
    const issues = final.error.issues
      .slice(0, 6)
      .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
      .join('; ');
    return { ok: false, error: 'plan schema: ' + issues };
  }
  return { ok: true, data: final.data };
}

// Helpers shared with the system planner's parsing code — inlined to
// keep this module dependency-free.
function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) {
    return t
      .replace(/^```(?:json|JSON)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
  }
  return t;
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

// Audit-friendly summary.
export function summariseSoftwareBuildPlan(plan: SoftwareBuildPlan): {
  total_tasks: number;
  by_layer: Record<string, number>;
  warnings: number;
} {
  const by_layer: Record<string, number> = { schema: 0, api: 0, ui: 0, auth: 0 };
  for (const t of plan.tasks) {
    by_layer[t.layer] = (by_layer[t.layer] ?? 0) + 1;
  }
  return {
    total_tasks: plan.tasks.length,
    by_layer,
    warnings: plan.warnings.length,
  };
}
