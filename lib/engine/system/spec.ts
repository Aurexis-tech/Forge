// Aurexis Forge — Phase 2 (Systems) spec schema.
//
// A SystemSpec describes a multi-agent system: a goal that decomposes
// into N sub-agents plus the coordination pattern that wires them
// together. This is the SECOND mold on the existing engine — Phase 1's
// AgentSpec keeps working unchanged. The engine picks the schema based
// on the `kind` discriminator persisted on the `specs` row (see
// supabase/migrations/0012_systems.sql).
//
// Phase 2 is INTAKE-ONLY: this prompt adds the schema, classifier,
// extractor, and review gate. Code generation, sandbox, deploy, and
// runtime stay on the agent path and are explicitly NOT extended yet.

import { z } from 'zod';
import { TRIGGERS } from '@/lib/engine/spec/schema';

export const COORDINATION_PATTERNS = ['pipeline', 'fan_out_in', 'dag'] as const;
export type CoordinationPattern = (typeof COORDINATION_PATTERNS)[number];

// Bound the runtime cost surface. max_steps is the maximum number of
// LLM turns the system can take across all sub-agents in a single
// invocation. DEFAULT keeps small systems cheap; the HARD CAP is the
// schema-enforced ceiling so a bad spec can never request a runaway
// budget. Non-negotiable per the Phase 2 spec brief.
export const DEFAULT_MAX_STEPS = 25;
export const HARD_CAP_MAX_STEPS = 100;

// Sub-agent ids are referenced from coordination.edges; they must be
// stable lower_snake_case identifiers (the same shape as Phase 1's
// capability tool ids).
const SubAgentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, 'sub_agent id must be lower_snake_case');

const ToolIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*$/, 'tool must be lower_snake_case');

const SubAgentSchema = z.object({
  id: SubAgentIdSchema,
  role: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
  inputs: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  outputs: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  // Optional — Phase 2 doesn't compile tools yet, but capturing them in
  // the spec lets the planner consume them later without re-asking.
  tools: z.array(ToolIdSchema).max(20).optional(),
});

const EdgeSchema = z.object({
  from: SubAgentIdSchema,
  to: SubAgentIdSchema,
});

const CoordinationSchema = z.object({
  pattern: z.enum(COORDINATION_PATTERNS),
  // edges are required for 'dag', conventional for 'fan_out_in', and
  // optional for 'pipeline' (sequential by sub_agent declaration order
  // when omitted). Cross-referential validity is checked in superRefine
  // below so we get a useful error message.
  edges: z.array(EdgeSchema).max(60).optional(),
});

export const SystemSpecSchema = z
  .object({
    goal: z.string().trim().min(1).max(800),
    sub_agents: z.array(SubAgentSchema).min(2).max(12),
    coordination: CoordinationSchema,
    // Reuse the Phase 1 trigger vocabulary so the planner / scheduler can
    // route a system the same way it routes a single agent later.
    triggers: z.array(z.enum(TRIGGERS)).min(1).max(4),
    max_steps: z
      .number()
      .int()
      .min(1)
      .max(
        HARD_CAP_MAX_STEPS,
        'max_steps cannot exceed ' + HARD_CAP_MAX_STEPS,
      )
      .default(DEFAULT_MAX_STEPS),
  })
  .superRefine((data, ctx) => {
    // sub_agent ids must be unique.
    const ids = new Set<string>();
    data.sub_agents.forEach((a, i) => {
      if (ids.has(a.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sub_agents', i, 'id'],
          message: "duplicate sub_agent id '" + a.id + "'",
        });
      }
      ids.add(a.id);
    });

    // edges must reference real ids; no self-loops.
    const edges = data.coordination.edges ?? [];
    edges.forEach((e, i) => {
      if (!ids.has(e.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coordination', 'edges', i, 'from'],
          message:
            "edge.from '" + e.from + "' does not match any sub_agent id",
        });
      }
      if (!ids.has(e.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coordination', 'edges', i, 'to'],
          message: "edge.to '" + e.to + "' does not match any sub_agent id",
        });
      }
      if (e.from === e.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coordination', 'edges', i],
          message: 'self-edges are not allowed',
        });
      }
    });

    // 'dag' must declare its edges explicitly — we don't infer a DAG
    // from declaration order.
    if (data.coordination.pattern === 'dag' && edges.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coordination', 'edges'],
        message: "coordination.pattern='dag' requires explicit edges",
      });
    }
  });

export type SystemSpec = z.infer<typeof SystemSpecSchema>;

// What the system extractor returns: the spec + optional clarifying
// questions. Mirrors the AgentSpec ExtractionResult so the state
// machine (pending → needs_clarification → awaiting_review → confirmed)
// applies uniformly.
export const SystemExtractionResultSchema = z.object({
  spec: SystemSpecSchema,
  open_questions: z
    .array(z.string().trim().min(1).max(400))
    .max(3)
    .default([]),
});
export type SystemExtractionResult = z.infer<typeof SystemExtractionResultSchema>;
