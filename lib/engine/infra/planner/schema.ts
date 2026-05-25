// Aurexis Forge — Phase 4 (Infrastructure) provisioning plan schema.
//
// A ProvisioningPlan is the deterministic output of the Phase 4 infra
// planner. It pairs a closed set of vetted modules with a DAG of
// provisioning steps: network → data store → workers, in resource-
// dependency order. Each step is grounded against a closed module id;
// the LLM detail pass cannot invent modules.
//
// The schema enforces structural invariants:
//   - step ids are unique
//   - depends_on references point at real step ids; no self-edges
//   - execution_order is a permutation of step ids
//   - module id is in the closed INFRA_MODULES catalog
//   - resource_id (when set) is a string — the planner cross-checks it
//     against the InfraSpec when stitching the plan
//
// CYCLE detection runs OUTSIDE the schema in graph.ts (reusing the
// Phase 1 validateTaskGraph Kahn topological sort), exactly like the
// software + system planners — keeps the schema fast and the cycle
// error messages consistent across phases.

import { z } from 'zod';
import {
  INFRA_MODULE_IDS,
  LAYERS,
  type InfraModuleId,
  type LayerId,
} from './modules';

const STEP_ID_RE = /^[a-z][a-z0-9_]*$/;
const StepIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(STEP_ID_RE, 'step id must be lower_snake_case starting with a letter');

const LayerSchema = z.enum(
  LAYERS.map((l) => l.id) as [LayerId, ...LayerId[]],
);

const ModuleIdSchema = z.enum(
  INFRA_MODULE_IDS as readonly InfraModuleId[] as [InfraModuleId, ...InfraModuleId[]],
);

// Step-level config is intentionally open — the user's spec already
// validated bounded primitives at intake; here we just carry the
// composed config the module needs. Shallow record only, bounded
// primitives, ≤30 keys.
const StepConfigValueSchema = z.union([
  z.string().trim().max(400),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().trim().max(400)).max(40),
]);

const StepConfigSchema = z
  .record(z.string().trim().min(1).max(80), StepConfigValueSchema)
  .refine((obj) => Object.keys(obj).length <= 30, {
    message: 'step.config may have at most 30 keys',
  });

const ProvisioningStepSchema = z.object({
  id: StepIdSchema,
  layer: LayerSchema,
  module: ModuleIdSchema,
  description: z.string().trim().min(1).max(800),
  depends_on: z.array(StepIdSchema).max(40).default([]),
  config: StepConfigSchema.default({}),
  // The InfraSpec resource this step provisions, when the module is
  // resource-specific (managed_postgres ↔ events_db). Null for shared
  // layer modules (private_network, service_identity, logs_metrics).
  resource_id: z.string().trim().min(1).max(80).nullable().default(null),
  // The secure defaults this step bakes in — surfaced unchanged from
  // the module catalog so the review panel can show them per step.
  secure_defaults: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});

export const ProvisioningPlanSchema = z
  .object({
    catalog_version: z.literal('v1'),
    steps: z.array(ProvisioningStepSchema).min(1).max(80),
    execution_order: z.array(StepIdSchema).min(1).max(80),
    warnings: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
  })
  .superRefine((data, ctx) => {
    // 1. Unique step ids + collect for cross-reference checks.
    const ids = new Set<string>();
    data.steps.forEach((s, i) => {
      if (ids.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', i, 'id'],
          message: "duplicate step id '" + s.id + "'",
        });
      }
      ids.add(s.id);
    });

    // 2. depends_on references must point at real step ids; no self-edges.
    data.steps.forEach((s, i) => {
      s.depends_on.forEach((dep, di) => {
        if (dep === s.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', i, 'depends_on', di],
            message: "step '" + s.id + "' depends on itself",
          });
        }
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', i, 'depends_on', di],
            message:
              "step '" + s.id + "' depends on unknown step '" + dep + "'",
          });
        }
      });
    });

    // 3. execution_order is a permutation of step ids.
    if (data.execution_order.length !== data.steps.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution_order'],
        message:
          'execution_order length (' +
          data.execution_order.length +
          ') must equal steps length (' +
          data.steps.length +
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
        if (!ids.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['execution_order'],
            message:
              "execution_order references unknown step id '" + id + "'",
          });
        }
      }
    }
  });

export type ProvisioningPlan = z.infer<typeof ProvisioningPlanSchema>;
export type ProvisioningStep = ProvisioningPlan['steps'][number];

export const CATALOG_VERSION: ProvisioningPlan['catalog_version'] = 'v1';
