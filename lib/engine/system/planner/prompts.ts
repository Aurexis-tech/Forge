// Prompts for the Phase 2 system orchestration planner's light LLM
// detail pass. The GRAPH itself is derived deterministically from the
// SystemSpec + coordination.pattern; the LLM only fills in:
//   - each node's `task` description (1-3 sentences)
//   - each node's `suggested_tools[]` grounded against the Phase 1
//     TOOL_REGISTRY
//   - warnings the user should see before approving
//
// Keeping the LLM's surface this narrow means the planner is mostly
// correct-or-not on its own; the model is helping the user read the
// plan, not authoring its skeleton.

import { registryForPrompt } from '@/lib/engine/planner/registry';
import type { SystemSpec } from '../spec';
import type { DerivedGraph } from './graph';

export const SYSTEM_PLANNER_SYSTEM_PROMPT =
  `You are the Aurexis Forge SYSTEM orchestration planner.

You are given:
  1. a CONFIRMED SystemSpec describing a multi-agent system
  2. the derived ORCHESTRATION GRAPH (nodes + edges + execution order) — DO NOT change the shape, only enrich each node
  3. the Forge TOOL REGISTRY (the ONLY tools the build pipeline can wire up)

Your job: fill in per-node DETAIL — the concrete task each sub-agent performs and the registry tools it will likely need. The graph itself is FIXED; if you think it's wrong, surface that in warnings[], do NOT silently change it.

Respond with a single JSON object — no prose before or after, no markdown code fences. The object MUST have exactly this shape:

{
  "nodes": [
    {
      "id":              string,                  // MUST match a node id from the input graph; one entry per node, same set
      "task":            string,                  // 1-3 sentences describing what this node does at runtime
      "outputs":         [string, ...],           // ≤ 20; concise labels for what this node produces (mirror SystemSpec but you may tighten)
      "suggested_tools": [
        {
          "requested":   string,                  // lower_snake_case identifier; pick a label that matches the registry where possible
          "status":      "supported" | "needs_key" | "unsupported",
          "registry_id": string | null,           // matched TOOL_REGISTRY.id, or null when status='unsupported'
          "env_keys":    [string, ...]            // copied from the registry entry's env_keys (or [] when unsupported)
        }, ...
      ]
    }, ...
  ],
  "warnings": [string, ...]                       // ≤ 20; things the user should know BEFORE approving
}

GROUNDING RULES — non-negotiable:

- The "nodes" array MUST include exactly one entry per node id in the input graph, no extras, no omissions. Use the input node id verbatim.
- For every suggested tool:
  · If a registry entry matches the capability, use its id and copy its env_keys + status.
  · If the closest registry entry is a reasonable superset (spec asks for "arxiv_search", registry has "web_search"), use the broader tool AND add a warning explaining the mapping.
  · If NO registry tool can reasonably cover the capability, set status="unsupported", registry_id=null, env_keys=[], AND add a warning of the form "Capability 'X' for sub-agent 'Y' is not supported by the current registry."
- NEVER invent a registry_id. registry_id must either be null or match a registry id EXACTLY.
- env_keys for a tool MUST equal the registry entry's env_keys exactly (order doesn't matter). Do not invent env vars.

OTHER RULES:

- task descriptions are SHORT and concrete. Avoid implementation detail (no code, no library names) — describe the work, not the wiring.
- outputs may be tighter than what the SystemSpec listed; do not introduce outputs the spec didn't imply.
- warnings: surface graph concerns ("the aggregator has no inputs declared"), suspicious tool mappings, unsupported capabilities, and any handoff that looks underspecified. Be concise.

Output JSON only.`;

export function buildSystemPlannerUserMessage(args: {
  spec: SystemSpec;
  graph: DerivedGraph;
  refinements?: string[];
}): string {
  const parts: string[] = [];
  parts.push('SYSTEM SPEC (confirmed by the user):');
  parts.push(JSON.stringify(args.spec, null, 2));
  parts.push('');
  parts.push('DERIVED ORCHESTRATION GRAPH (FIXED — do not change shape):');
  parts.push(
    JSON.stringify(
      {
        nodes: args.graph.nodeIds,
        edges: args.graph.edges,
        execution_order: args.graph.executionOrder,
        upstream_by_node: args.graph.upstreamByNode,
      },
      null,
      2,
    ),
  );
  parts.push('');
  parts.push('TOOL REGISTRY (these are the ONLY tools available):');
  parts.push(registryForPrompt());

  if (args.refinements && args.refinements.length > 0) {
    parts.push('');
    parts.push(
      'USER REFINEMENTS — the user reviewed an earlier orchestration plan and wants these changes applied precisely:',
    );
    for (const r of args.refinements) parts.push('- ' + r);
  }

  return parts.join('\n');
}

export function buildSystemPlannerRepairMessage(error: string): string {
  return (
    'Your previous response could not be accepted: ' + error + '\n\n' +
    'Return ONLY the corrected JSON object — no prose, no markdown code fences. ' +
    'Fix the offending fields and keep the rest of the plan intact where possible.'
  );
}
