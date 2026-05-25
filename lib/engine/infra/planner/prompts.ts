// Prompts for the Phase 4 infrastructure planner's light LLM detail pass.
//
// The provisioning DAG is derived deterministically by graph.ts from
// the InfraSpec + the closed module catalog. The LLM ONLY fills in:
//   - tightened per-step descriptions (what this step accomplishes)
//   - planner-level warnings (e.g. "spec has a worker but no queue
//     between it and the database — writes will be synchronous")
//
// The LLM does NOT reshape the graph and does NOT invent module ids.
// Keeping its surface this narrow means the planner is mostly correct-
// or-not on its own, and the brief's "never raw provider / IAM / network
// config" guarantee is enforced structurally (the module catalog is
// closed and the schema enum gates it).

import type { InfraSpec } from '@/lib/engine/infra/spec';
import type { InfraDerivedGraph } from './graph';
import { catalogForPrompt } from './modules';

export const INFRA_PLANNER_SYSTEM_PROMPT =
  `You are the Aurexis Forge INFRASTRUCTURE provisioning planner.

You are given:
  1. a CONFIRMED InfraSpec describing a piece of infrastructure (resources + topology + lifecycle)
  2. the derived PROVISIONING DAG (steps + dependencies + execution order) — DO NOT change the shape, only enrich each step's description
  3. the closed MODULE CATALOG the steps compose

Your job: fill in per-step DETAIL — a clear, concrete description of what each provisioning step accomplishes. The graph itself is FIXED; if you think a step is missing or wrong, surface that in warnings[]. Do NOT silently add, drop, re-wire steps, or change module ids.

Respond with a single JSON object — no prose before or after, no markdown code fences. The object MUST have exactly this shape:

{
  "steps": [
    {
      "id":          string,                    // MUST match a step id from the input graph; one entry per step
      "description": string                     // 1-3 sentences in plain English; what this step provisions and why
    }, ...
  ],
  "warnings": [string, ...]                     // ≤ 20; things the user should know BEFORE approving the plan
}

GROUNDING RULES — non-negotiable:

- The "steps" array MUST include exactly one entry per step id in the input graph, no extras, no omissions. Use the input step id verbatim.

- Step descriptions are SHORT (1-3 sentences) and CONCRETE. Describe what the step provisions, not how the provider implements it. No raw provider names (no "AWS S3", no "GCP PubSub"), no Terraform / Pulumi / CloudFormation snippets, no IAM JSON.

- DO NOT plan raw provider, IAM, or network config. The module catalog provides vetted recipes with secure defaults; your descriptions should say "compose the <module>" and reference the module's purpose — never re-author the underlying primitives.

- DO NOT invent new steps, change step ids, change layers, change module ids, or rearrange dependencies. Surface concerns in warnings[] instead.

- WARNINGS to consider:
  · The spec has a compute resource (worker / http_service) with no data resource it points at → flag (it probably needs storage).
  · The spec has a queue but no worker consuming it (or vice versa) → flag.
  · The spec asked for ephemeral lifecycle but declared a postgres_db → flag (data will be wiped each run).
  · The spec named a region that conflicts with the user's other resources → flag (informational).
  · A resource's sizing.note implies a public-facing scale (e.g. "1M req/day") but no http_service is declared → flag.

Output JSON only.`;

export function buildInfraPlannerUserMessage(args: {
  spec: InfraSpec;
  graph: InfraDerivedGraph;
  refinements?: string[];
}): string {
  const parts: string[] = [];
  parts.push('INFRASTRUCTURE SPEC (confirmed by the user):');
  parts.push(JSON.stringify(args.spec, null, 2));
  parts.push('');
  parts.push('DERIVED PROVISIONING DAG (FIXED — do not change shape):');
  parts.push(
    JSON.stringify(
      {
        steps: args.graph.steps.map((s) => ({
          id: s.id,
          layer: s.layer,
          module: s.module,
          resource_id: s.resource_id,
          depends_on: s.depends_on,
        })),
        execution_order: args.graph.executionOrder,
        upstream_by_step: args.graph.upstreamByStep,
      },
      null,
      2,
    ),
  );
  parts.push('');
  parts.push('MODULE CATALOG (the closed set of vetted modules the steps compose):');
  parts.push(catalogForPrompt());

  if (args.refinements && args.refinements.length > 0) {
    parts.push('');
    parts.push(
      'USER REFINEMENTS — the user reviewed an earlier provisioning plan and wants these changes applied precisely:',
    );
    for (const r of args.refinements) parts.push('- ' + r);
  }

  return parts.join('\n');
}

export function buildInfraPlannerRepairMessage(error: string): string {
  return (
    'Your previous response could not be accepted: ' + error + '\n\n' +
    'Return ONLY the corrected JSON object — no prose, no markdown code fences. ' +
    'Fix the offending fields and keep the rest of the plan intact where possible.'
  );
}
