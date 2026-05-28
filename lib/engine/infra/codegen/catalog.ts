// The vetted Terraform module catalog.
//
// Each entry corresponds 1:1 with an InfraModuleId from
// lib/engine/infra/planner/modules.ts and defines:
//
//   - the registry source the generated `module "..."` block points at
//     (a vetted Forge-published Terraform module — NOT a freehand
//     resource block)
//   - the input parameter names the module accepts (whitelist — any
//     other key from the plan step's config is silently dropped at
//     compose time, so a malformed plan can't smuggle in unvetted
//     fields)
//   - the OUTPUT names the module exports, for downstream wiring
//   - the SECURE-DEFAULT flags baked into the module itself; these are
//     emitted verbatim into the generated .tf file as a leading comment
//     block so a human reading the IaC sees what the module guarantees
//     without having to chase the registry source
//
// The generator (compose.ts) reads ONLY from this catalog. There is NO
// code path that emits a raw resource block. Adding a new module is a
// deliberate code change: add an entry here, add it to the planner
// catalog (lib/engine/infra/planner/modules.ts), and (if needed)
// extend the generator's wiring rules.

import type { InfraModuleId } from '@/lib/engine/infra/planner/modules';

export interface IacModuleSpec {
  // The Terraform module address. ALL entries point at the
  // 'aurexis-forge/<id>/composable' namespace — the closed registry
  // the Forge curates. A real deployment ships these modules from the
  // platform team's Terraform registry. In tests we just assert the
  // address is present in the generated .tf; we never resolve it.
  source: string;
  // Pinned major version of the module. Locks the contract — a module
  // upgrade requires a deliberate catalog version bump.
  version: string;
  // INPUT whitelist. The generator drops any plan-step config key that
  // is not on this list. Inputs not present in the plan-step config
  // default to the module's own secure default (the module author's
  // responsibility, not the generator's).
  inputs: readonly string[];
  // OUTPUT contract the module exposes. Downstream modules wire to
  // these via `module.<step_id>.<output>` references.
  outputs: readonly string[];
  // Secure-default flags this module guarantees. Surfaced verbatim as
  // a comment block at the top of the generated .tf file so a human
  // reviewer sees what's baked in.
  secure_default_flags: {
    private_by_default: boolean;
    tls: boolean;
    least_privilege_iam: boolean;
    kms_encryption: boolean;
  };
}

// The closed catalog. The keys MUST match the InfraModuleId union from
// lib/engine/infra/planner/modules.ts exactly — TypeScript enforces
// this via the satisfies clause below.
export const IAC_CATALOG = {
  private_network: {
    source: 'aurexis-forge/private-network/composable',
    version: '1.0.0',
    inputs: ['region'],
    outputs: ['vpc_id', 'private_subnet_ids', 'security_group_id'],
    secure_default_flags: {
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: false, // network layer doesn't encrypt; data layer does
    },
  },
  service_identity: {
    source: 'aurexis-forge/service-identity/composable',
    version: '1.0.0',
    inputs: [],
    outputs: ['identity_pool_id'],
    secure_default_flags: {
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: false,
    },
  },
  managed_postgres: {
    source: 'aurexis-forge/managed-postgres/composable',
    version: '1.0.0',
    inputs: ['region', 'version', 'storage_gb', 'instance_class'],
    outputs: ['endpoint', 'port', 'connection_secret_arn'],
    secure_default_flags: {
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  private_object_store: {
    source: 'aurexis-forge/private-object-store/composable',
    version: '1.0.0',
    inputs: ['region', 'lifecycle_days'],
    outputs: ['bucket_arn', 'bucket_name'],
    secure_default_flags: {
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  managed_queue: {
    source: 'aurexis-forge/managed-queue/composable',
    version: '1.0.0',
    inputs: ['region', 'visibility_timeout_s', 'max_receive_count'],
    outputs: ['queue_arn', 'dlq_arn'],
    secure_default_flags: {
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  managed_cache: {
    source: 'aurexis-forge/managed-cache/composable',
    version: '1.0.0',
    inputs: ['region', 'node_type', 'engine_version'],
    outputs: ['cache_endpoint', 'cache_port'],
    secure_default_flags: {
      // In-VPC only (no public endpoint); encrypted at rest + in transit.
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  secrets_manager: {
    source: 'aurexis-forge/secrets-manager/composable',
    version: '1.0.0',
    inputs: ['region', 'rotation_days'],
    outputs: ['secret_arn', 'secret_name'],
    secure_default_flags: {
      // KMS-encrypted; reachable only via a least-privilege resource policy.
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  cdn: {
    source: 'aurexis-forge/cdn/composable',
    version: '1.0.0',
    inputs: ['region', 'price_class', 'origin_url', 'origin_bucket'],
    outputs: ['distribution_domain', 'distribution_id'],
    secure_default_flags: {
      // Origin stays private (origin access control); HTTPS-only with a
      // modern TLS floor; edge cache encrypted at rest.
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  container_worker: {
    source: 'aurexis-forge/container-worker/composable',
    version: '1.0.0',
    inputs: [
      'image',
      'instances',
      'cpu',
      'memory_mb',
      'sizing_note',
      'image_tag',
    ],
    outputs: ['service_name'],
    secure_default_flags: {
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  scheduler: {
    source: 'aurexis-forge/scheduler/composable',
    version: '1.0.0',
    inputs: ['schedule', 'sizing_note'],
    outputs: ['rule_arn'],
    secure_default_flags: {
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  http_service: {
    source: 'aurexis-forge/http-service/composable',
    version: '1.0.0',
    inputs: [
      'image',
      'instances',
      'cpu',
      'memory_mb',
      'public',
      'sizing_note',
      'image_tag',
    ],
    outputs: ['service_url', 'service_name'],
    secure_default_flags: {
      // http_service is private-by-default — public=true is opt-in via
      // the InfraSpec config. The compose layer enforces this by
      // refusing to flip `public` to true unless the resource's spec
      // config explicitly set it.
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
  logs_metrics_pipeline: {
    source: 'aurexis-forge/logs-metrics-pipeline/composable',
    version: '1.0.0',
    inputs: ['retention_days'],
    outputs: ['log_group_arn'],
    secure_default_flags: {
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    },
  },
} as const satisfies Record<InfraModuleId, IacModuleSpec>;

export type IacCatalogKey = keyof typeof IAC_CATALOG;

// Helper — throws if the id is not in the catalog. Closed catalog
// means this should be unreachable when the input went through the
// ProvisioningPlanSchema enum gate.
export function iacModuleSpec(id: InfraModuleId): IacModuleSpec {
  const spec = IAC_CATALOG[id];
  if (!spec) {
    throw new Error('unknown IaC module id: ' + id);
  }
  return spec;
}
