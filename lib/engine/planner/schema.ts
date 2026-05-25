// Single source of truth for the BuildPlan shape + task-graph invariants.
// Downstream layers (codegen, sandbox, integrations) import `BuildPlan` from
// here — never duplicate the shape.

import { z } from 'zod';
import { TOOL_REGISTRY } from './registry';

export const HOSTING = ['vercel_function', 'worker'] as const;
export const RUNTIME_IMPLS = ['on_demand', 'always_on'] as const;
export const TOOL_STATUSES = ['supported', 'needs_key', 'unsupported'] as const;
export const RISKS = ['low', 'medium', 'high'] as const;

const TASK_ID_RE = /^[a-z][a-z0-9_]*$/;

const TaskSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(TASK_ID_RE, 'task id must be lower_snake_case starting with a letter'),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  depends_on: z.array(z.string().trim().min(1).max(60)).max(20),
});

const PlanToolSchema = z.object({
  requested: z.string().trim().min(1).max(80),
  status: z.enum(TOOL_STATUSES),
  registry_id: z.string().trim().min(1).max(80).nullable(),
  env_keys: z.array(z.string().trim().min(1).max(100)).max(10),
});

const PlanFileSchema = z.object({
  path: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(400),
});

const PlanEnvSchema = z.object({
  key: z.string().trim().min(1).max(100),
  why: z.string().trim().min(1).max(400),
  secret: z.boolean(),
});

const PlanEstimateSchema = z.object({
  risk: z.enum(RISKS),
  complexity: z.enum(RISKS),
  notes: z.string().trim().min(1).max(800),
});

const TargetSchema = z.object({
  framework: z.string().trim().min(1).max(80),
  hosting: z.enum(HOSTING),
  entrypoint: z.string().trim().min(1).max(200),
});

export const BuildPlanSchema = z.object({
  scaffold: z.string().trim().min(1).max(120),
  target: TargetSchema,
  trigger_impl: z.string().trim().min(1).max(800),
  runtime_impl: z.enum(RUNTIME_IMPLS),
  tools: z.array(PlanToolSchema).max(30),
  files: z.array(PlanFileSchema).max(40),
  env_required: z.array(PlanEnvSchema).max(30),
  tasks: z.array(TaskSchema).min(1).max(40),
  estimate: PlanEstimateSchema,
  warnings: z.array(z.string().trim().min(1).max(400)).max(20),
});

export type BuildPlan = z.infer<typeof BuildPlanSchema>;
export type PlanTask = BuildPlan['tasks'][number];
export type PlanTool = BuildPlan['tools'][number];

// --- Task-graph validation -------------------------------------------------

export type DagIssueKind =
  | 'duplicate_id'
  | 'unknown_dep'
  | 'self_dep'
  | 'cycle';

export interface DagIssue {
  kind: DagIssueKind;
  message: string;
}

export function validateTaskGraph(tasks: readonly PlanTask[]): DagIssue[] {
  const issues: DagIssue[] = [];

  // 1. unique ids
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) duplicates.add(t.id);
    seen.add(t.id);
  }
  for (const id of duplicates) {
    issues.push({
      kind: 'duplicate_id',
      message: `duplicate task id: '${id}'`,
    });
  }

  // 2. depends_on references + self-deps
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (dep === t.id) {
        issues.push({
          kind: 'self_dep',
          message: `task '${t.id}' depends on itself`,
        });
        continue;
      }
      if (!seen.has(dep)) {
        issues.push({
          kind: 'unknown_dep',
          message: `task '${t.id}' depends on unknown task '${dep}'`,
        });
      }
    }
  }

  // 3. cycle detection via Kahn topological sort
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const t of tasks) {
    adj.set(t.id, []);
    indeg.set(t.id, 0);
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (seen.has(dep) && dep !== t.id) {
        adj.get(dep)!.push(t.id);
        indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      }
    }
  }
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const next of adj.get(id) ?? []) {
      const nd = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, nd);
      if (nd === 0) queue.push(next);
    }
  }
  if (visited !== tasks.length) {
    issues.push({
      kind: 'cycle',
      message: 'task graph contains a cycle (dependencies must be acyclic)',
    });
  }

  return issues;
}

// --- Tool-registry validation ---------------------------------------------

export type ToolIssueKind = 'unknown_registry_id' | 'status_mismatch' | 'invented_env_key';

export interface ToolIssue {
  kind: ToolIssueKind;
  message: string;
}

// Cross-check the planner's `tools[]` against the live registry. Catches
// hallucinated registry_ids and lies about env_keys.
export function validatePlanTools(plan: BuildPlan): ToolIssue[] {
  const issues: ToolIssue[] = [];
  for (const t of plan.tools) {
    if (t.status === 'unsupported') {
      if (t.registry_id !== null) {
        issues.push({
          kind: 'status_mismatch',
          message: `tool '${t.requested}' is unsupported but has a registry_id`,
        });
      }
      continue;
    }
    if (t.registry_id === null) {
      issues.push({
        kind: 'status_mismatch',
        message: `tool '${t.requested}' is ${t.status} but has no registry_id`,
      });
      continue;
    }
    const entry = TOOL_REGISTRY.find((r) => r.id === t.registry_id);
    if (!entry) {
      issues.push({
        kind: 'unknown_registry_id',
        message: `tool '${t.requested}' references unknown registry_id '${t.registry_id}'`,
      });
      continue;
    }
    if (entry.status === 'needs_key' && t.status !== 'needs_key') {
      issues.push({
        kind: 'status_mismatch',
        message: `tool '${t.requested}' maps to '${entry.id}' which needs_key, but plan marks it '${t.status}'`,
      });
    }
    for (const k of t.env_keys) {
      if (!entry.env_keys.includes(k)) {
        issues.push({
          kind: 'invented_env_key',
          message: `tool '${t.requested}' lists env_key '${k}' that the registry does not require`,
        });
      }
    }
  }
  return issues;
}

export function issuesToErrorString(
  dag: DagIssue[],
  tools: ToolIssue[],
): string {
  return [...dag, ...tools].map((i) => `[${i.kind}] ${i.message}`).join('; ');
}
