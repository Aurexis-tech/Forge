// Aurexis Forge — Phase 3 (Software) build plan schema.
//
// A SoftwareBuildPlan is the deterministic output of the Phase 3
// planner. It pairs a vetted template (template_id) with a DAG of
// tasks that FILL the template's slots. Each task targets exactly one
// slot.kind (from lib/engine/software/planner/template.ts) and may
// depend on earlier tasks (schema → api → ui → auth wiring).
//
// The schema enforces structural invariants:
//   - task ids are unique
//   - depends_on references point at real task ids; no self-edges
//   - execution_order is a permutation of task ids
//   - slot.kind is in the closed SLOT_KINDS catalog
//   - the task's layer matches the slot's layer
//
// CYCLE detection runs OUTSIDE the schema in graph.ts (reusing the
// Phase 1 validateTaskGraph Kahn topological sort), exactly like the
// system planner does — keeps the schema fast and the cycle error
// messages consistent across phases.

import { z } from 'zod';
import {
  LAYERS,
  SLOT_KINDS,
  SLOT_LAYER,
  TEMPLATE_ID,
  type LayerId,
  type SlotKind,
} from './template';

const TASK_ID_RE = /^[a-z][a-z0-9_]*$/;
const TaskIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(TASK_ID_RE, 'task id must be lower_snake_case starting with a letter');

const LayerSchema = z.enum(
  LAYERS.map((l) => l.id) as [LayerId, ...LayerId[]],
);

const SlotKindSchema = z.enum(SLOT_KINDS as readonly SlotKind[] as [SlotKind, ...SlotKind[]]);

// target is the entity name (for schema/api tasks), page id (for ui
// tasks), or null for template-wide auth slots.
const SlotSchema = z.object({
  kind: SlotKindSchema,
  target: z.string().trim().min(1).max(80).nullable(),
});

const SoftwareTaskSchema = z.object({
  id: TaskIdSchema,
  layer: LayerSchema,
  description: z.string().trim().min(1).max(800),
  depends_on: z.array(TaskIdSchema).max(40).default([]),
  slot: SlotSchema,
  // Relative file paths the codegen scaffold should write/extend when
  // it later compiles this plan. Bounded so a runaway plan can't
  // request hundreds of files per task.
  files: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
});

export const SoftwareBuildPlanSchema = z
  .object({
    template_id: z.literal(TEMPLATE_ID),
    tasks: z.array(SoftwareTaskSchema).min(1).max(80),
    execution_order: z.array(TaskIdSchema).min(1).max(80),
    warnings: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
  })
  .superRefine((data, ctx) => {
    // 1. Unique task ids + collect for cross-reference checks.
    const ids = new Set<string>();
    data.tasks.forEach((t, i) => {
      if (ids.has(t.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', i, 'id'],
          message: "duplicate task id '" + t.id + "'",
        });
      }
      ids.add(t.id);
    });

    // 2. depends_on references must point at real task ids; no self-edges.
    data.tasks.forEach((t, i) => {
      t.depends_on.forEach((dep, di) => {
        if (dep === t.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', i, 'depends_on', di],
            message: "task '" + t.id + "' depends on itself",
          });
        }
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', i, 'depends_on', di],
            message:
              "task '" + t.id + "' depends on unknown task '" + dep + "'",
          });
        }
      });
    });

    // 3. slot.layer must match task.layer — keeps the four-layer
    //    structure honest. The catalog in template.ts is the source of truth.
    data.tasks.forEach((t, i) => {
      const expectedLayer = SLOT_LAYER[t.slot.kind];
      if (expectedLayer !== t.layer) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', i, 'layer'],
          message:
            "task '" + t.id + "' is declared in layer '" + t.layer +
            "' but its slot.kind '" + t.slot.kind +
            "' belongs to layer '" + expectedLayer + "'",
        });
      }
    });

    // 4. execution_order is a permutation of task ids.
    if (data.execution_order.length !== data.tasks.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution_order'],
        message:
          'execution_order length (' +
          data.execution_order.length +
          ') must equal tasks length (' +
          data.tasks.length +
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
              "execution_order references unknown task id '" + id + "'",
          });
        }
      }
    }
  });

export type SoftwareBuildPlan = z.infer<typeof SoftwareBuildPlanSchema>;
export type SoftwareTask = SoftwareBuildPlan['tasks'][number];
