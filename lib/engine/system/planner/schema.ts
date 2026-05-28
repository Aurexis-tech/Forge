// Aurexis Forge — Phase 2 (Systems) orchestration plan schema.
//
// An OrchestrationPlan is the output of the SYSTEM planner. Where the
// Phase 1 BuildPlan describes how to compile and ship a single agent,
// the OrchestrationPlan describes how the sub-agents of a SystemSpec
// will be wired together at runtime: which one runs first, what data
// flows between them, and what registry tools each sub-agent will be
// asked to bring.
//
// This schema is the contract between Phase 2's planner and the future
// Phase 2-3 / 2-4 code generation passes. Keeping it strict here means
// the downstream layers can rely on a topologically-sorted,
// reference-checked plan without re-doing graph validation.

import { z } from 'zod';
import { TOOL_REGISTRY } from '@/lib/engine/planner/registry';
import {
  COORDINATION_PATTERNS,
  ENGINE_LOOP_CEILING,
  HARD_CAP_MAX_STEPS,
} from '../spec';

// IDs reused from SystemSpec — same lower_snake_case shape so that nothing
// drifts between the two schemas.
const NODE_ID_RE = /^[a-z][a-z0-9_]*$/;
const NodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(NODE_ID_RE, 'node id must be lower_snake_case starting with a letter');

const ToolIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*$/, 'tool id must be lower_snake_case');

export const TOOL_STATUSES = ['supported', 'needs_key', 'unsupported'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

// What an upstream sub-agent hands a downstream sub-agent. `from === null`
// means "external input to the system" (the initial trigger payload).
const HandoffSchema = z.object({
  from: NodeIdSchema.nullable(),
  output: z.string().trim().min(1).max(200),
});

// One tool the LLM-detail pass thinks this sub-agent will need. Grounded
// against the Phase 1 TOOL_REGISTRY so we never plan a hallucinated tool.
const PlanToolSchema = z.object({
  requested: ToolIdSchema,
  status: z.enum(TOOL_STATUSES),
  registry_id: ToolIdSchema.nullable(),
  env_keys: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
});

const NodeSchema = z.object({
  id: NodeIdSchema,
  role: z.string().trim().min(1).max(120),
  // 1-3 sentences describing what THIS node does in concrete terms.
  task: z.string().trim().min(1).max(800),
  inputs: z.array(HandoffSchema).max(20).default([]),
  outputs: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  suggested_tools: z.array(PlanToolSchema).max(15).default([]),
});

const EdgeSchema = z.object({
  from: NodeIdSchema,
  to: NodeIdSchema,
  // Short label describing the data crossing the wire — surfaces in the
  // review UI so the user can sanity-check the handoff before approving.
  payload: z.string().trim().min(1).max(200),
});

// OPTIONAL bounded-loop metadata — present ONLY for the loop_with_break
// pattern. Mirrors DerivedGraph.LoopMetadata. The plan's nodes/edges/
// execution_order still describe the ACYCLIC body+controller subgraph;
// this carries the runtime-only loop bounds + back edge. Additive +
// backward-compatible: every other pattern omits it. Structural checks
// (controllerId / bodyNodeIds / backEdge reference real nodes) run in
// superRefine below.
const LoopMetaSchema = z.object({
  controllerId: NodeIdSchema,
  bodyNodeIds: z.array(NodeIdSchema).min(1).max(12),
  // Bounded to the same hard ceiling the spec + runtime enforce, so a
  // hand-crafted plan can't smuggle a runaway cap past validation.
  maxIterations: z.number().int().min(1).max(ENGINE_LOOP_CEILING),
  breakCondition: z.string().trim().min(1).max(800),
  backEdge: z.object({ from: NodeIdSchema, to: NodeIdSchema }),
});

// OPTIONAL selection metadata — present ONLY for the router pattern.
// Mirrors DerivedGraph.BranchMetadata. The plan's nodes/edges/
// execution_order describe the ACYCLIC router+branches DAG; this carries
// which node is the router + which node ids belong to each decision key,
// so the generated orchestrator can run exactly one branch. Additive +
// backward-compatible. Structural checks (router/branch ids reference real
// nodes) run in superRefine below.
const BranchMetaSchema = z.object({
  routerId: NodeIdSchema,
  branches: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(60),
        nodeIds: z.array(NodeIdSchema).min(1).max(12),
      }),
    )
    .min(2)
    .max(12),
});

export const OrchestrationPlanSchema = z
  .object({
    goal: z.string().trim().min(1).max(800),
    pattern: z.enum(COORDINATION_PATTERNS),
    // Mirrors SystemSpec.max_steps — enforced in the planner itself; here
    // we just constrain to the same hard cap so a hand-crafted plan
    // can't sneak past the budget gate.
    max_steps: z.number().int().min(1).max(HARD_CAP_MAX_STEPS),
    nodes: z.array(NodeSchema).min(2).max(12),
    edges: z.array(EdgeSchema).max(60).default([]),
    // The topologically-sorted execution order. The PLANNER computes
    // this; the schema only checks that what's stored matches the nodes
    // 1-1. Cycle detection happens in graph.ts before this is built.
    execution_order: z.array(NodeIdSchema).min(2).max(12),
    warnings: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
    // OPTIONAL loop metadata (loop_with_break only). Additive +
    // backward-compatible — omitted for standard + competing_experts.
    loop: LoopMetaSchema.optional(),
    // OPTIONAL branch metadata (router only). Additive + backward-compatible.
    branch: BranchMetaSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const nodeIds = new Set<string>();
    data.nodes.forEach((n, i) => {
      if (nodeIds.has(n.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', i, 'id'],
          message: "duplicate node id '" + n.id + "'",
        });
      }
      nodeIds.add(n.id);
    });

    // edges reference real nodes; no self-edges.
    data.edges.forEach((e, i) => {
      if (!nodeIds.has(e.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', i, 'from'],
          message: "edge.from '" + e.from + "' does not match any node id",
        });
      }
      if (!nodeIds.has(e.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', i, 'to'],
          message: "edge.to '" + e.to + "' does not match any node id",
        });
      }
      if (e.from === e.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', i],
          message: 'self-edges are not allowed',
        });
      }
    });

    // node.inputs[].from references a real node (or is null = external).
    data.nodes.forEach((n, i) => {
      n.inputs.forEach((h, j) => {
        if (h.from !== null && !nodeIds.has(h.from)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', i, 'inputs', j, 'from'],
            message: "handoff.from '" + h.from + "' does not match any node id",
          });
        }
      });
    });

    // execution_order is a permutation of node ids.
    if (data.execution_order.length !== data.nodes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution_order'],
        message:
          'execution_order length (' +
          data.execution_order.length +
          ") must equal nodes length (" +
          data.nodes.length +
          ')',
      });
    } else {
      const orderSet = new Set(data.execution_order);
      if (orderSet.size !== data.execution_order.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['execution_order'],
          message: 'execution_order contains duplicates',
        });
      }
      for (const id of data.execution_order) {
        if (!nodeIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['execution_order'],
            message:
              "execution_order references unknown node id '" + id + "'",
          });
        }
      }
    }

    // Tool grounding — same rules as Phase 1's planner: registry_id is
    // either null (when unsupported) or matches a real registry entry,
    // and env_keys come from the registry, not invented.
    data.nodes.forEach((n, ni) => {
      n.suggested_tools.forEach((t, ti) => {
        if (t.status === 'unsupported') {
          if (t.registry_id !== null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', ni, 'suggested_tools', ti, 'registry_id'],
              message:
                "tool '" + t.requested + "' is unsupported but has a registry_id",
            });
          }
          return;
        }
        if (t.registry_id === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', ni, 'suggested_tools', ti, 'registry_id'],
            message:
              "tool '" + t.requested + "' is " + t.status + " but has no registry_id",
          });
          return;
        }
        const entry = TOOL_REGISTRY.find((r) => r.id === t.registry_id);
        if (!entry) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', ni, 'suggested_tools', ti, 'registry_id'],
            message:
              "tool '" + t.requested + "' references unknown registry_id '" +
              t.registry_id + "'",
          });
          return;
        }
        for (const k of t.env_keys) {
          if (!entry.env_keys.includes(k)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', ni, 'suggested_tools', ti, 'env_keys'],
              message:
                "env_key '" + k + "' is not required by registry tool '" +
                entry.id + "'",
            });
          }
        }
      });
    });

    // Loop metadata (loop_with_break) — every referenced id must be a
    // real node, the controller must NOT be a body node, and the back
    // edge endpoints must be body nodes. Keeps the runtime's bounded
    // loop honest about which nodes it re-invokes.
    if (data.loop) {
      const l = data.loop;
      const ref = (id: string, where: string) => {
        if (!nodeIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loop', where],
            message: "loop." + where + " '" + id + "' does not match any node id",
          });
        }
      };
      ref(l.controllerId, 'controllerId');
      l.bodyNodeIds.forEach((id) => ref(id, 'bodyNodeIds'));
      ref(l.backEdge.from, 'backEdge.from');
      ref(l.backEdge.to, 'backEdge.to');
      if (l.bodyNodeIds.includes(l.controllerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['loop', 'controllerId'],
          message: 'controllerId must not also be a body node',
        });
      }
    }

    // Branch metadata (router) — router + every branch node must be a real
    // node, the router must NOT be a branch node, and keys must be
    // distinct. Keeps the orchestrator's conditional skip honest about
    // which nodes belong to which branch.
    if (data.branch) {
      const b = data.branch;
      if (!nodeIds.has(b.routerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['branch', 'routerId'],
          message: "branch.routerId '" + b.routerId + "' does not match any node id",
        });
      }
      const seenKeys = new Set<string>();
      b.branches.forEach((br, bi) => {
        if (seenKeys.has(br.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['branch', 'branches', bi, 'key'],
            message: "duplicate branch key '" + br.key + "'",
          });
        }
        seenKeys.add(br.key);
        br.nodeIds.forEach((id, ni) => {
          if (!nodeIds.has(id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['branch', 'branches', bi, 'nodeIds', ni],
              message: "branch node '" + id + "' does not match any node id",
            });
          }
          if (id === b.routerId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['branch', 'branches', bi, 'nodeIds', ni],
              message: 'a branch node must not be the router',
            });
          }
        });
      });
    }
  });

export type OrchestrationPlan = z.infer<typeof OrchestrationPlanSchema>;
export type OrchestrationNode = OrchestrationPlan['nodes'][number];
export type OrchestrationEdge = OrchestrationPlan['edges'][number];
