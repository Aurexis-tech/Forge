// The vetted infrastructure module catalog the Phase 4 planner targets.
//
// "Vetted" means each module here has been security-reviewed for safe
// defaults: least-privilege IAM, private-by-default networking, sane
// encryption + retention defaults, and no public exposure unless the
// InfraSpec explicitly requested it (lifecycle/region/config opt-ins).
//
// The planner composes plans EXCLUSIVELY from this catalog — same
// closed-catalog guarantee as the Software planner's auth slots
// (lib/engine/software/planner/template.ts). The LLM detail pass
// CANNOT introduce new modules; it only enriches per-step descriptions.
// Adding a new module is a deliberate code change: list it here, teach
// graph.ts to emit a step when the right resource type appears, and
// teach the Zod schema to accept the new module id.
//
// Layers order the DAG: network first (private subnet + service
// accounts), then data stores (databases, buckets, queues), then
// runtime workloads that depend on them (workers, http services,
// crons), and finally observability wiring.

import type { ResourceType } from '@/lib/engine/infra/spec';

// ---------------------------------------------------------------------------
// LAYERS — high-level grouping. Provisioning steps are organised into
// these layers so the topo sort produces a build-order-friendly read.
// ---------------------------------------------------------------------------

export const LAYERS = [
  { id: 'network',       label: 'Network & identity',      order: 1 },
  { id: 'data',          label: 'Data stores & queues',    order: 2 },
  { id: 'compute',       label: 'Workloads & schedulers',  order: 3 },
  { id: 'observability', label: 'Observability wiring',    order: 4 },
] as const;
export type LayerId = (typeof LAYERS)[number]['id'];

export const LAYER_ORDER: Record<LayerId, number> = {
  network: 1,
  data: 2,
  compute: 3,
  observability: 4,
};

// ---------------------------------------------------------------------------
// MODULES — the closed catalog. Each module is a vetted recipe with
// secure defaults; the planner composes modules, it never authors raw
// provider, IAM, or network config.
// ---------------------------------------------------------------------------

export interface InfraModule {
  id: string;
  layer: LayerId;
  label: string;
  purpose: string;
  // Resource types from the InfraSpec catalog this module is the
  // PRIMARY composition target for. A module can be used for several
  // resource types (e.g. a worker module can host a `worker` or be
  // triggered by a `cron`).
  applies_to: readonly ResourceType[];
  // Short list of the secure defaults this module bakes in. Surfaced
  // in the UI so the reviewer can see what they're getting.
  secure_defaults: readonly string[];
}

export const INFRA_MODULES = [
  // --- network layer -----------------------------------------------------
  {
    id: 'private_network',
    layer: 'network',
    label: 'Private network',
    purpose:
      'Provision the VPC, private subnets, and security groups every other resource attaches to. Nothing is reachable from the public internet by default.',
    applies_to: [],
    secure_defaults: [
      'private subnets only',
      'no inbound public CIDRs',
      'egress restricted to allowlisted endpoints',
    ],
  },
  {
    id: 'service_identity',
    layer: 'network',
    label: 'Service identity',
    purpose:
      'Mint per-resource service accounts with least-privilege IAM policies. Every workload runs under its own identity; no shared keys.',
    applies_to: [],
    secure_defaults: [
      'one identity per resource',
      'least-privilege IAM',
      'short-lived credentials',
    ],
  },

  // --- data layer --------------------------------------------------------
  {
    id: 'managed_postgres',
    layer: 'data',
    label: 'Managed Postgres database',
    purpose:
      'Provision a managed Postgres instance attached to the private network. TLS-only, automated backups, per-tenant credentials.',
    applies_to: ['postgres_db'],
    secure_defaults: [
      'TLS-only connections',
      'private VPC access (no public endpoint)',
      'encrypted-at-rest',
      'daily automated backups',
    ],
  },
  {
    id: 'private_object_store',
    layer: 'data',
    label: 'Private object store bucket',
    purpose:
      'Provision a versioned, private object-storage bucket. No public ACLs, server-side encryption on, lifecycle rules wired.',
    applies_to: ['object_store'],
    secure_defaults: [
      'all-public-access blocked',
      'server-side encryption (SSE)',
      'object versioning enabled',
      'lifecycle expiry for noncurrent versions',
    ],
  },
  {
    id: 'managed_queue',
    layer: 'data',
    label: 'Managed message queue',
    purpose:
      'Provision a managed queue with a dead-letter queue, encrypted messages, and a sane visibility-timeout default.',
    applies_to: ['queue'],
    secure_defaults: [
      'KMS-encrypted in transit + at rest',
      'dead-letter queue on retry exhaustion',
      'IAM-scoped producer/consumer access',
    ],
  },

  // --- compute layer -----------------------------------------------------
  {
    id: 'container_worker',
    layer: 'compute',
    label: 'Containerised worker',
    purpose:
      'Long-running worker process bound to a private network with a per-resource service identity. Autoscaling within configured bounds.',
    applies_to: ['worker'],
    secure_defaults: [
      'runs under per-resource service identity',
      'no public ingress',
      'autoscale bounded by spec sizing',
      'crash-restart with exponential backoff',
    ],
  },
  {
    id: 'scheduler',
    layer: 'compute',
    label: 'Scheduled job (cron)',
    purpose:
      'Managed scheduler that triggers downstream resources on a cron expression. Idempotency keys + at-least-once delivery.',
    applies_to: ['cron'],
    secure_defaults: [
      'cron expression validated at plan time',
      'idempotency key per fire',
      'at-least-once delivery with retry budget',
    ],
  },
  {
    id: 'http_service',
    layer: 'compute',
    label: 'HTTP service',
    purpose:
      'Containerised HTTP service behind a managed load balancer. mTLS to internal callers; public exposure is opt-in via spec config only.',
    applies_to: ['http_service'],
    secure_defaults: [
      'private by default',
      'mTLS for internal traffic',
      'rate-limited public endpoints (only when spec opts in)',
      'health-check + readiness probes',
    ],
  },

  // --- observability layer ----------------------------------------------
  {
    id: 'logs_metrics_pipeline',
    layer: 'observability',
    label: 'Logs + metrics pipeline',
    purpose:
      'Wire every resource into the central logs + metrics pipeline. Audit-grade retention; no raw secrets in payloads.',
    applies_to: [],
    secure_defaults: [
      'structured log shipping',
      'metrics scraped from each resource',
      'audit-grade retention windows',
      'redaction filter for known secret-shaped values',
    ],
  },
] as const satisfies readonly InfraModule[];

export type InfraModuleId = (typeof INFRA_MODULES)[number]['id'];

export const INFRA_MODULE_IDS = INFRA_MODULES.map((m) => m.id) as readonly InfraModuleId[];

// Map a resource type to the module that provisions it. The graph
// emits one provisioning step per (resource × module) pair plus the
// shared layer modules (private_network, service_identity, logs_metrics_pipeline).
export const MODULE_BY_RESOURCE: Record<ResourceType, InfraModuleId> = {
  postgres_db:  'managed_postgres',
  object_store: 'private_object_store',
  queue:        'managed_queue',
  worker:       'container_worker',
  cron:         'scheduler',
  http_service: 'http_service',
};

export function moduleById(id: InfraModuleId): InfraModule {
  const m = INFRA_MODULES.find((x) => x.id === id);
  if (!m) {
    // Closed catalog — unreachable by construction; the schema enum
    // gate prevents it at the boundary.
    throw new Error('unknown infra module id: ' + id);
  }
  return m;
}

// Compact JSON description of the catalog the LLM consumes during the
// detail pass. Bounded so we never bloat the prompt.
export function catalogForPrompt(): string {
  return JSON.stringify(
    {
      layers: LAYERS.map((l) => ({ id: l.id, label: l.label, order: l.order })),
      modules: INFRA_MODULES.map((m) => ({
        id: m.id,
        layer: m.layer,
        label: m.label,
        purpose: m.purpose,
        applies_to: m.applies_to,
        secure_defaults: m.secure_defaults,
      })),
      rules: [
        'Steps reference module ids from this catalog only. Do not invent new modules.',
        'Never plan raw provider, IAM, or network config — only compose vetted modules.',
        'Public exposure is opt-in: if the spec config did not request it, keep the resource private.',
        'Auth / least-privilege / encryption defaults come from the modules; do not re-author them.',
      ],
    },
    null,
    2,
  );
}
