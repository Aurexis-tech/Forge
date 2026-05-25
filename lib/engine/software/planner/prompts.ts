// Prompts for the Phase 3 software planner's light LLM detail pass.
//
// The build-task GRAPH is derived deterministically by graph.ts from
// the SoftwareSpec + the vetted template. The LLM ONLY fills in:
//   - tightened per-task descriptions
//   - planner-level warnings (e.g. "the Expense entity has no
//     submitted_by → User reference; per-user isolation needs one")
//
// The LLM does NOT reshape the graph and does NOT invent slot kinds.
// Keeping its surface this narrow means the planner is mostly correct-
// or-not on its own, and the brief's "do not plan hand-rolled auth"
// constraint is enforced structurally (the slot catalog is closed).

import type { SoftwareSpec } from '../spec';
import type { SoftwareDerivedGraph } from './graph';
import { templateForPrompt } from './template';

export const SOFTWARE_PLANNER_SYSTEM_PROMPT =
  `You are the Aurexis Forge SOFTWARE build planner.

You are given:
  1. a CONFIRMED SoftwareSpec describing a small web app
  2. the derived BUILD TASK GRAPH (tasks + dependencies + execution order) — DO NOT change the shape, only enrich each task's description
  3. the vetted TEMPLATE catalog the tasks fill

Your job: fill in per-task DETAIL — a clear, concrete description of what each task accomplishes. The graph itself is FIXED; if you think a task is missing or wrong, surface that in warnings[]. Do NOT silently add, drop, or re-wire tasks.

Respond with a single JSON object — no prose before or after, no markdown code fences. The object MUST have exactly this shape:

{
  "tasks": [
    {
      "id":          string,                    // MUST match a task id from the input graph; one entry per task
      "description": string                     // 1-3 sentences in plain English; what this task accomplishes
    }, ...
  ],
  "warnings": [string, ...]                     // ≤ 20; things the user should know BEFORE approving the plan
}

GROUNDING RULES — non-negotiable:

- The "tasks" array MUST include exactly one entry per task id in the input graph, no extras, no omissions. Use the input task id verbatim.

- Task descriptions are SHORT (1-3 sentences) and CONCRETE. Describe what the task accomplishes, not how to implement it. No code, no library names, no SQL.

- DO NOT plan hand-rolled auth or per-user isolation. The template provides session_middleware, role_gate, and per_user_isolation_check — your auth-layer descriptions should say "wire the template's <slot>" and nothing more.

- DO NOT invent new tasks, change task ids, change layers, change slot kinds, or rearrange dependencies. Surface concerns in warnings[] instead.

- WARNINGS to consider:
  · An entity has no obvious "owner" field but per-user isolation is on → flag.
  · A flow references a page that exists but no API routes for the entities its description mentions → flag.
  · A page does not appear in any flow → flag (it may be a launcher / nav page, in which case the warning is informational).
  · The spec declares integrations the template doesn't yet support → flag.

Output JSON only.`;

export function buildSoftwarePlannerUserMessage(args: {
  spec: SoftwareSpec;
  graph: SoftwareDerivedGraph;
  refinements?: string[];
}): string {
  const parts: string[] = [];
  parts.push('SOFTWARE SPEC (confirmed by the user):');
  parts.push(JSON.stringify(args.spec, null, 2));
  parts.push('');
  parts.push('DERIVED BUILD TASK GRAPH (FIXED — do not change shape):');
  parts.push(
    JSON.stringify(
      {
        tasks: args.graph.tasks.map((t) => ({
          id: t.id,
          layer: t.layer,
          slot: t.slot,
          depends_on: t.depends_on,
        })),
        execution_order: args.graph.executionOrder,
        upstream_by_task: args.graph.upstreamByTask,
      },
      null,
      2,
    ),
  );
  parts.push('');
  parts.push('TEMPLATE CATALOG (the closed set of slots the tasks fill):');
  parts.push(templateForPrompt());

  if (args.refinements && args.refinements.length > 0) {
    parts.push('');
    parts.push(
      'USER REFINEMENTS — the user reviewed an earlier build plan and wants these changes applied precisely:',
    );
    for (const r of args.refinements) parts.push('- ' + r);
  }

  return parts.join('\n');
}

export function buildSoftwarePlannerRepairMessage(error: string): string {
  return (
    'Your previous response could not be accepted: ' + error + '\n\n' +
    'Return ONLY the corrected JSON object — no prose, no markdown code fences. ' +
    'Fix the offending fields and keep the rest of the plan intact where possible.'
  );
}
