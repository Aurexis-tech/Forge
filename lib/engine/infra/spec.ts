// Aurexis Forge — Phase 4 (Infrastructure) spec schema.
//
// An InfraSpec describes a piece of data/runtime infrastructure: a set
// of resources (databases, object stores, queues, workers, schedulers,
// http services) connected by a topology of dependencies, scoped to a
// lifecycle (ephemeral / persistent) and optionally a region. This is
// the FOURTH and FINAL mold on the existing engine — Phase 1's
// AgentSpec, Phase 2's SystemSpec, and Phase 3's SoftwareSpec continue
// to work unchanged. The engine picks the schema based on the `kind`
// discriminator persisted on the `specs` row (extended in
// supabase/migrations/0016_infrastructure.sql to include
// 'infrastructure').
//
// Phase 4 is INTAKE-ONLY in this prompt: schema, classifier extension,
// extractor, persistence, review gate. Generation, preview, and
// provisioning (P4-3+) are NOT wired up yet — confirmed infrastructure
// specs stop at the gate, and the three sibling planner loaders refuse
// them server-side (defence in depth for direct API callers).

import { z } from 'zod';

// Resource ids reuse the lower_snake_case convention shared with
// AgentSpec capability tools, SystemSpec sub_agent ids, and SoftwareSpec
// page ids. Topology edges reference resources by these stable ids.
const ID_RE = /^[a-z][a-z0-9_]*$/;
const ResourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(ID_RE, 'resource id must be lower_snake_case starting with a letter');

// CLOSED catalog of resource types the infra mold understands. Adding
// a new type is a deliberate code change — the extractor MUST pick
// from this list and validation hard-rejects anything else. Each name
// is a coarse-grained primitive that downstream provisioning (P4-3+)
// can map onto a concrete cloud-resource template; here we just
// capture the user's intent at the right level of abstraction.
export const RESOURCE_TYPES = [
  'postgres_db',
  'object_store',
  'queue',
  'worker',
  'cron',
  'http_service',
  // Gap-filling additions — each maps to a vetted secure-by-default module:
  'cache',        // managed_cache (ElastiCache): encrypted + private (in-VPC)
  'secret_store', // secrets_manager (Secrets Manager): KMS + least-privilege
  'cdn',          // cdn (CloudFront): HTTPS-only + private origin (OAC)
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

// Free-form sizing hint the user mentioned ("small", "10GB", "burst
// to 4 workers"). Optional — most resources don't need it at intake.
const SizingSchema = z
  .object({
    note: z.string().trim().min(1).max(200).optional(),
    instances: z.number().int().min(1).max(1000).optional(),
    storage_gb: z.number().min(0).max(1_000_000).optional(),
  })
  .strict();

// Resource-specific config is intentionally open at intake — the
// extractor records what the user said (e.g. schedule for a cron,
// runtime for a worker, region/version for a db) without locking it
// to a per-type schema. The downstream provisioner will tighten this
// per type when it lands. Values are bounded primitives only — no
// nested objects past one level so the spec stays auditable.
const ConfigValueSchema = z.union([
  z.string().trim().max(400),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().trim().max(400)).max(20),
]);

const ResourceConfigSchema = z
  .record(z.string().trim().min(1).max(80), ConfigValueSchema)
  .refine((obj) => Object.keys(obj).length <= 20, {
    message: 'resource.config may have at most 20 keys',
  });

const ResourceSchema = z.object({
  id: ResourceIdSchema,
  type: z.enum(RESOURCE_TYPES),
  config: ResourceConfigSchema.default({}),
  sizing: SizingSchema.optional(),
});

// Topology edge: a directed dependency between two resources, e.g.
// worker → postgres_db (worker depends on / writes to the db),
// cron → worker (cron triggers worker). Cycles are NOT rejected at
// intake — provisioning later may need them (queue-feeding-itself
// patterns) — but self-edges are rejected since they're always a
// modelling mistake.
const TopologyEdgeSchema = z.object({
  from: ResourceIdSchema,
  to: ResourceIdSchema,
});

export const InfraSpecSchema = z
  .object({
    goal: z.string().trim().min(1).max(800),
    resources: z.array(ResourceSchema).min(1).max(20),
    topology: z.array(TopologyEdgeSchema).max(60).default([]),
    region: z.string().trim().min(1).max(60).optional(),
    lifecycle: z.enum(['ephemeral', 'persistent']),
  })
  .superRefine((data, ctx) => {
    // Unique resource ids.
    const ids = new Set<string>();
    data.resources.forEach((r, i) => {
      if (ids.has(r.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resources', i, 'id'],
          message: "duplicate resource id '" + r.id + "'",
        });
      }
      ids.add(r.id);
    });

    // Topology references must point at real resource ids, and no
    // self-edges. Both invariants are cheap to catch here and would
    // be hard to repair downstream.
    data.topology.forEach((e, i) => {
      if (!ids.has(e.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['topology', i, 'from'],
          message: "topology edge references unknown resource '" + e.from + "'",
        });
      }
      if (!ids.has(e.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['topology', i, 'to'],
          message: "topology edge references unknown resource '" + e.to + "'",
        });
      }
      if (e.from === e.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['topology', i],
          message: "self-edge on resource '" + e.from + "' is not allowed",
        });
      }
    });
  });

export type InfraSpec = z.infer<typeof InfraSpecSchema>;

// Mirrors the AgentSpec / SystemSpec / SoftwareSpec extraction result
// shape so the pending → needs_clarification → awaiting_review →
// confirmed state machine applies uniformly across all four kinds.
export const InfraExtractionResultSchema = z.object({
  spec: InfraSpecSchema,
  open_questions: z
    .array(z.string().trim().min(1).max(400))
    .max(3)
    .default([]),
});
export type InfraExtractionResult = z.infer<typeof InfraExtractionResultSchema>;
