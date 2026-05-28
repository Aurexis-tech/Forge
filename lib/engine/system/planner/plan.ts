// Phase 2 system orchestration planner pipeline.
//
//   planSystem(): confirmed SystemSpec (+ optional refinements)
//                 → validated OrchestrationPlan
//
// Flow:
//   1. Derive graph from coordination.pattern (deterministic, no LLM)
//   2. Run the REUSED Phase 1 task-graph validator (Kahn topo + cycle)
//   3. Enforce SystemSpec.max_steps against the node count
//   4. Light LLM pass (sonnet) to enrich each node with task + tools
//      (+ one repair retry if the response doesn't validate)
//   5. Stitch LLM output onto the deterministic graph and run the
//      OrchestrationPlanSchema validation
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
import {
  COORDINATION_PATTERNS,
  type SystemSpec,
} from '../spec';
import {
  assertWithinStepBudget,
  SystemGraphError,
  SystemPlanBudgetError,
  type DerivedEdge,
  type DerivedGraph,
} from './graph';
import { expandCoordination } from '../coordination';
import { EngineError } from '@/lib/engine/errors';
import {
  OrchestrationPlanSchema,
  TOOL_STATUSES,
  type OrchestrationPlan,
  type OrchestrationNode,
} from './schema';
import {
  SYSTEM_PLANNER_SYSTEM_PROMPT,
  buildSystemPlannerRepairMessage,
  buildSystemPlannerUserMessage,
} from './prompts';

export class SystemPlanError extends Error {
  readonly cause?: unknown;
  readonly raw?: string;
  constructor(message: string, opts?: { cause?: unknown; raw?: string }) {
    super(message);
    this.name = 'SystemPlanError';
    this.cause = opts?.cause;
    this.raw = opts?.raw;
  }
}

export interface PlanSystemInput {
  spec: SystemSpec;
  refinements?: string[];
  governance: GovernanceScope;
}

export interface PlanSystemOutput {
  plan: OrchestrationPlan;
  usage: LLMUsage;
  model: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Entry point. Cycle / budget rejections throw with a clear message so the
// caller can surface them verbatim; LLM-stage rejections retry once.
// ---------------------------------------------------------------------------
export async function planSystem(
  input: PlanSystemInput,
): Promise<PlanSystemOutput> {
  // --- 1 + 2. Derive + validate the graph (deterministic, no LLM) ---------
  // Dispatch through the coordination-pattern catalog. For a 'standard'
  // spec (or one with no coordination_pattern) this delegates to
  // deriveGraph — byte-identical. competing_experts expands a
  // fan-out-to-judge DAG and throws bad_input on a constraint violation.
  let graph: DerivedGraph;
  try {
    graph = expandCoordination(input.spec);
  } catch (err) {
    if (err instanceof SystemGraphError) {
      throw new SystemPlanError(err.message, { cause: err });
    }
    // Pattern constraint violations (competing_experts expert/judge
    // counts) surface as bad_input EngineErrors — wrap them so the route
    // sees a clean SystemPlanError like any other graph rejection.
    if (err instanceof EngineError) {
      throw new SystemPlanError(err.message, { cause: err });
    }
    throw err;
  }

  // --- 3. Step budget -----------------------------------------------------
  try {
    assertWithinStepBudget(graph, input.spec.max_steps);
  } catch (err) {
    if (err instanceof SystemPlanBudgetError) {
      throw new SystemPlanError(err.message, { cause: err });
    }
    throw err;
  }

  const userMessage = buildSystemPlannerUserMessage({
    spec: input.spec,
    graph,
    refinements: input.refinements,
  });

  const govPass1: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'system.plan') + '.pass1',
  };
  const govRepair: GovernanceScope = {
    ...input.governance,
    ref: (input.governance.ref ?? 'system.plan') + '.repair',
  };

  // --- 4. Light LLM detail pass ------------------------------------------
  const first = await complete({
    model: PLANNER_MODEL,
    system: SYSTEM_PLANNER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 3000,
    governance: govPass1,
  });

  const stitched1 = stitchAndValidate(first.text, input.spec, graph);
  if (stitched1.ok) {
    return {
      plan: stitched1.data,
      usage: first.usage,
      model: first.model,
      attempts: 1,
    };
  }

  // --- Repair retry -------------------------------------------------------
  let repair;
  try {
    repair = await complete({
      model: PLANNER_MODEL,
      system: SYSTEM_PLANNER_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: first.text },
        { role: 'user', content: buildSystemPlannerRepairMessage(stitched1.error) },
      ],
      maxTokens: 3000,
      governance: govRepair,
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new SystemPlanError('Repair attempt failed: ' + err.message, {
        cause: err,
        raw: first.text,
      });
    }
    throw err;
  }

  const stitched2 = stitchAndValidate(repair.text, input.spec, graph);
  const totalUsage = sumUsage(first.usage, repair.usage);

  if (stitched2.ok) {
    return {
      plan: stitched2.data,
      usage: totalUsage,
      model: repair.model,
      attempts: 2,
    };
  }

  throw new SystemPlanError(
    'Could not produce a valid OrchestrationPlan after repair retry. Last validation error: ' +
      stitched2.error,
    { raw: repair.text },
  );
}

// ---------------------------------------------------------------------------
// LLM output schema — the model returns ONLY the per-node enrichment; we
// stitch that onto the deterministic graph and validate the assembled
// OrchestrationPlan against the full schema. Keeps the LLM surface narrow.
// ---------------------------------------------------------------------------
const LlmNodeDetailSchema = z.object({
  id: z.string().trim().min(1).max(60),
  task: z.string().trim().min(1).max(800),
  outputs: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  suggested_tools: z
    .array(
      z.object({
        requested: z.string().trim().min(1).max(80),
        status: z.enum(TOOL_STATUSES),
        registry_id: z.string().trim().min(1).max(80).nullable(),
        env_keys: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
      }),
    )
    .max(15)
    .default([]),
});
const LlmDetailSchema = z.object({
  nodes: z.array(LlmNodeDetailSchema).min(1).max(12),
  warnings: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
});

interface StitchOk { ok: true; data: OrchestrationPlan; }
interface StitchErr { ok: false; error: string; }

function stitchAndValidate(
  text: string,
  spec: SystemSpec,
  graph: DerivedGraph,
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

  // Every node id from the graph must appear exactly once in the LLM output.
  const detailById = new Map<string, z.infer<typeof LlmNodeDetailSchema>>();
  for (const n of detail.data.nodes) detailById.set(n.id, n);
  for (const id of graph.nodeIds) {
    if (!detailById.has(id)) {
      return { ok: false, error: "LLM detail missing node '" + id + "'" };
    }
  }
  for (const n of detail.data.nodes) {
    if (!graph.nodeIds.includes(n.id)) {
      return { ok: false, error: "LLM detail introduced unknown node '" + n.id + "'" };
    }
  }

  // Build the per-node handoff list from the upstream map. The first
  // node (no upstreams) gets a single external-input handoff so the
  // downstream layer knows where the system payload enters.
  const inputsByNode = buildInputsByNode(graph, detail.data.nodes, spec.sub_agents.map((a) => a.id));

  // Stitch the OrchestrationPlan.
  const nodes: OrchestrationNode[] = graph.nodeIds.map((id) => {
    const d = detailById.get(id)!;
    const subAgent = spec.sub_agents.find((s) => s.id === id);
    const role = subAgent?.role ?? id;
    // Prefer LLM-tightened outputs but fall back to the spec's outputs
    // if the LLM omitted them.
    const outputs = d.outputs.length > 0 ? d.outputs : subAgent?.outputs ?? [];
    return {
      id,
      role,
      task: d.task,
      inputs: inputsByNode[id] ?? [],
      outputs,
      suggested_tools: d.suggested_tools.map((t) => ({
        requested: t.requested,
        status: t.status,
        registry_id: t.registry_id,
        env_keys: t.env_keys,
      })),
    };
  });

  const planCandidate = {
    goal: spec.goal,
    pattern: ensurePattern(spec.coordination.pattern),
    max_steps: spec.max_steps,
    nodes,
    edges: graph.edges,
    execution_order: graph.executionOrder,
    warnings: detail.data.warnings,
    // Thread the deterministic loop metadata (loop_with_break) onto the
    // plan so the runtime can drive the bounded loop. Undefined for every
    // other pattern — the schema field is optional, so this is additive.
    ...(graph.loop ? { loop: graph.loop } : {}),
    // Thread the branch metadata (router) onto the plan so the generated
    // orchestrator can run exactly the selected branch. Additive.
    ...(graph.branch ? { branch: graph.branch } : {}),
  };

  const final = OrchestrationPlanSchema.safeParse(planCandidate);
  if (!final.success) {
    const issues = final.error.issues
      .slice(0, 6)
      .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
      .join('; ');
    return { ok: false, error: 'plan schema: ' + issues };
  }
  return { ok: true, data: final.data };
}

function ensurePattern(p: string): (typeof COORDINATION_PATTERNS)[number] {
  // The SystemSpec validator already restricts pattern; this is a typed
  // narrowing for the OrchestrationPlanSchema's z.enum.
  return p as (typeof COORDINATION_PATTERNS)[number];
}

// Build the handoff list per node. We trust the graph (deterministic):
// the inputs to node X are exactly the outputs of its upstream nodes,
// pulled from the LLM-detailed `outputs` (or the spec's outputs as a
// fallback). Nodes with no upstream get a single { from: null,
// output: '<external trigger payload>' } so downstream layers know where
// the system's input enters.
function buildInputsByNode(
  graph: DerivedGraph,
  detailNodes: ReadonlyArray<z.infer<typeof LlmNodeDetailSchema>>,
  declaredOrderIds: readonly string[],
): Record<string, Array<{ from: string | null; output: string }>> {
  const result: Record<string, Array<{ from: string | null; output: string }>> = {};
  const detailById = new Map(detailNodes.map((d) => [d.id, d] as const));
  void declaredOrderIds; // kept for future ordering tweaks
  for (const id of graph.nodeIds) {
    const upstreams = graph.upstreamByNode[id] ?? [];
    if (upstreams.length === 0) {
      result[id] = [{ from: null, output: 'external trigger payload' }];
      continue;
    }
    const inputs: Array<{ from: string | null; output: string }> = [];
    for (const upId of upstreams) {
      const upDetail = detailById.get(upId);
      const outputs = upDetail?.outputs ?? [];
      if (outputs.length === 0) {
        inputs.push({ from: upId, output: 'handoff' });
      } else {
        // One handoff entry per upstream output; keeps the downstream
        // wire-up plan unambiguous.
        for (const o of outputs) inputs.push({ from: upId, output: o });
      }
    }
    result[id] = inputs;
  }
  return result;
}

// Helpers reused from the Phase 1 planner's parse pipeline — kept inline
// rather than imported so the system planner has no dependency on the
// agent planner's parsing utilities.
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

// Convenience summary for the audit log.
export function summariseOrchestrationPlan(plan: OrchestrationPlan): {
  nodes: number;
  edges: number;
  pattern: string;
  warnings: number;
  tool_coverage: { supported: number; needs_key: number; unsupported: number };
} {
  let supported = 0;
  let needs_key = 0;
  let unsupported = 0;
  for (const n of plan.nodes) {
    for (const t of n.suggested_tools) {
      if (t.status === 'supported') supported++;
      else if (t.status === 'needs_key') needs_key++;
      else unsupported++;
    }
  }
  return {
    nodes: plan.nodes.length,
    edges: plan.edges.length,
    pattern: plan.pattern,
    warnings: plan.warnings.length,
    tool_coverage: { supported, needs_key, unsupported },
  };
}

// Re-export DerivedEdge for the persistence/audit modules.
export type { DerivedEdge };
