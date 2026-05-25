// Phase 4 infrastructure provisioning planner pipeline.
//
//   planInfra(): confirmed InfraSpec (+ optional refinements)
//                → validated ProvisioningPlan
//
// Flow:
//   1. Derive base provisioning DAG from spec + module catalog
//      (deterministic, no LLM)
//   2. Run the REUSED Phase 1 task-graph validator inside graph.ts
//      (Kahn topo + cycle + dup + unknown-dep detection)
//   3. Light LLM pass (sonnet) — fills in per-step descriptions and
//      surfaces warnings; ONE repair retry on validation failure
//   4. Stitch LLM output onto the deterministic graph, validate the
//      assembled plan against ProvisioningPlanSchema
//
// All LLM calls flow through lib/engine/llm.complete so cost recording
// + governance + BYOK key resolution are inherited from Phase 1.

import { z } from 'zod';
import {
  LLMError,
  PLANNER_MODEL,
  complete,
  sumUsage,
  type GovernanceScope,
  type LLMUsage,
} from '@/lib/engine/llm';
import type { InfraSpec } from '@/lib/engine/infra/spec';
import {
  InfraGraphError,
  deriveInfraGraph,
  type InfraDerivedGraph,
  type InfraDerivedStep,
} from './graph';
import {
  CATALOG_VERSION,
  ProvisioningPlanSchema,
  type ProvisioningPlan,
  type ProvisioningStep,
} from './schema';
import {
  INFRA_PLANNER_SYSTEM_PROMPT,
  buildInfraPlannerRepairMessage,
  buildInfraPlannerUserMessage,
} from './prompts';

export class InfraPlanError extends Error {
  readonly cause?: unknown;
  readonly raw?: string;
  constructor(message: string, opts?: { cause?: unknown; raw?: string }) {
    super(message);
    this.name = 'InfraPlanError';
    this.cause = opts?.cause;
    this.raw = opts?.raw;
  }
}

export interface PlanInfraInput {
  spec: InfraSpec;
  refinements?: string[];
  governance: GovernanceScope;
}

export interface PlanInfraOutput {
  plan: ProvisioningPlan;
  usage: LLMUsage;
  model: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Entry point. Graph rejections throw with a clear message the caller
// can surface verbatim; LLM-stage rejections retry once.
// ---------------------------------------------------------------------------
export async function planInfra(
  input: PlanInfraInput,
): Promise<PlanInfraOutput> {
  // --- 1 + 2. Derive + validate the graph (deterministic, no LLM) -------
  let graph: InfraDerivedGraph;
  try {
    graph = deriveInfraGraph(input.spec);
  } catch (err) {
    if (err instanceof InfraGraphError) {
      throw new InfraPlanError(err.message, { cause: err });
    }
    throw err;
  }

  const userMessage = buildInfraPlannerUserMessage({
    spec: input.spec,
    graph,
    refinements: input.refinements,
  });

  const govPass1: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'infra.plan') + '.pass1',
  };
  const govRepair: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'infra.plan') + '.repair',
  };

  // --- 3. Light LLM detail pass -----------------------------------------
  const first = await complete({
    model: PLANNER_MODEL,
    system: INFRA_PLANNER_SYSTEM_PROMPT,
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
      model: PLANNER_MODEL,
      system: INFRA_PLANNER_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: first.text },
        { role: 'user', content: buildInfraPlannerRepairMessage(stitched1.error) },
      ],
      maxTokens: 3000,
      governance: govRepair,
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new InfraPlanError('Repair attempt failed: ' + err.message, {
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

  throw new InfraPlanError(
    'Could not produce a valid ProvisioningPlan after repair retry. Last validation error: ' +
      stitched2.error,
    { raw: repair.text },
  );
}

// ---------------------------------------------------------------------------
// LLM-output schema (the narrow per-step enrichment surface).
// ---------------------------------------------------------------------------
const LlmStepDetailSchema = z.object({
  id: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(800),
});
const LlmDetailSchema = z.object({
  steps: z.array(LlmStepDetailSchema).min(1).max(80),
  warnings: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
});

interface StitchOk { ok: true; data: ProvisioningPlan; }
interface StitchErr { ok: false; error: string; }

function stitchAndValidate(
  text: string,
  graph: InfraDerivedGraph,
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

  // Every step id from the graph must appear exactly once in the LLM output.
  const detailById = new Map<string, z.infer<typeof LlmStepDetailSchema>>();
  for (const s of detail.data.steps) detailById.set(s.id, s);
  for (const s of graph.steps) {
    if (!detailById.has(s.id)) {
      return { ok: false, error: "LLM detail missing step '" + s.id + "'" };
    }
  }
  for (const s of detail.data.steps) {
    if (!graph.steps.some((g) => g.id === s.id)) {
      return { ok: false, error: "LLM detail introduced unknown step '" + s.id + "'" };
    }
  }

  // Stitch — keep the deterministic graph as the source of truth for
  // layer / module / depends_on / config / resource_id / secure_defaults;
  // only the description is taken from the LLM.
  const stitched: ProvisioningStep[] = graph.steps.map((s: InfraDerivedStep) => ({
    id: s.id,
    layer: s.layer,
    module: s.module,
    description: detailById.get(s.id)?.description ?? s.description,
    depends_on: s.depends_on,
    config: s.config as ProvisioningStep['config'],
    resource_id: s.resource_id,
    secure_defaults: s.secure_defaults,
  }));

  const planCandidate = {
    catalog_version: CATALOG_VERSION,
    steps: stitched,
    execution_order: graph.executionOrder,
    warnings: detail.data.warnings,
  };

  const final = ProvisioningPlanSchema.safeParse(planCandidate);
  if (!final.success) {
    const issues = final.error.issues
      .slice(0, 6)
      .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
      .join('; ');
    return { ok: false, error: 'plan schema: ' + issues };
  }
  return { ok: true, data: final.data };
}

// Helpers shared with the system + software planners' parsing code —
// inlined to keep this module dependency-free.
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
export function summariseProvisioningPlan(plan: ProvisioningPlan): {
  total_steps: number;
  by_layer: Record<string, number>;
  modules_used: string[];
  warnings: number;
} {
  const by_layer: Record<string, number> = {
    network: 0,
    data: 0,
    compute: 0,
    observability: 0,
  };
  const moduleSet = new Set<string>();
  for (const s of plan.steps) {
    by_layer[s.layer] = (by_layer[s.layer] ?? 0) + 1;
    moduleSet.add(s.module);
  }
  return {
    total_steps: plan.steps.length,
    by_layer,
    modules_used: Array.from(moduleSet).sort(),
    warnings: plan.warnings.length,
  };
}
