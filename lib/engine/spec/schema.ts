// Single source of truth for the AgentSpec shape.
// Every downstream layer (planner, codegen, sandbox, runtime) imports the
// inferred `AgentSpec` type from here — never duplicates the shape.

import { z } from 'zod';

export const TRIGGERS = ['chat', 'api', 'schedule', 'webhook'] as const;
export const RUNTIMES = ['on_demand', 'always_on'] as const;
export const RISKS = ['low', 'medium', 'high'] as const;

const NamedItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
});

const CapabilitySchema = z.object({
  tool: z
    .string()
    .trim()
    .min(1)
    .max(80)
    // snake_case identifiers — the build pipeline resolves these.
    .regex(/^[a-z][a-z0-9_]*$/, 'tool must be lower_snake_case'),
  why: z.string().trim().min(1).max(400),
});

export const AgentSpecSchema = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(400),
  description: z.string().trim().min(1).max(2000),
  trigger: z.enum(TRIGGERS),
  runtime: z.enum(RUNTIMES),
  inputs: z.array(NamedItemSchema).max(20),
  capabilities: z.array(CapabilitySchema).max(20),
  outputs: z.array(NamedItemSchema).max(20),
  constraints: z.array(z.string().trim().min(1).max(400)).max(20),
  success_criteria: z.array(z.string().trim().min(1).max(400)).max(20),
  risk: z.enum(RISKS),
  confidence: z.number().min(0).max(1),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

// What the extractor returns: a spec plus (optionally) clarifying questions.
export const ExtractionResultSchema = z.object({
  spec: AgentSpecSchema,
  open_questions: z
    .array(z.string().trim().min(1).max(400))
    .max(3)
    .default([]),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
