// Deterministic INFRA PREVIEW engine.
//
// From an approved + composed ProvisioningPlan, derive:
//
//   1. A human-readable list of WHAT WOULD BE CREATED — one entry per
//      module step, grouped by layer (network → data → compute →
//      observability). Each entry names the catalog module + the
//      logical resources it would provision. The text is derived
//      ENTIRELY from the catalog metadata + the plan step's bounded
//      config. NO LLM round.
//
//   2. A COST ESTIMATE — per-step monthly USD via
//      estimateStepUsdPerMonth, summed into a total. The estimator is
//      pure + deterministic; same plan → same number every run.
//
// The output is INERT — derived from the catalog + plan + composed
// .tf text. NO `terraform plan` call. NO cloud-provider API call. NO
// credentials needed.
//
// This module is the "preview half" of P4-4; the "gate half" lives in
// ceiling.ts (compares the estimate against the user's budget).

import type {
  ProvisioningPlan,
  ProvisioningStep,
} from '@/lib/engine/infra/planner/schema';
import type {
  InfraModuleId,
  LayerId,
} from '@/lib/engine/infra/planner/modules';
import {
  moduleById,
  LAYER_ORDER,
} from '@/lib/engine/infra/planner/modules';
import {
  estimateStepUsdPerMonth,
  monthlyToHourly,
} from './pricing';

// ---------------------------------------------------------------------------
// Resource taxonomy — what each module "creates" in human-readable
// terms. Closed catalog: one entry per InfraModuleId, listing the
// concrete cloud objects the module's underlying Terraform would
// provision. The preview surfaces these verbatim.
//
// These strings are SHOWN TO THE USER and BAKED INTO THE AUDIT LOG.
// Editing them is fine — they're descriptive, not load-bearing.
// ---------------------------------------------------------------------------

const RESOURCES_BY_MODULE: Record<InfraModuleId, ReadonlyArray<string>> = {
  private_network: [
    'VPC',
    'private subnets (3 across AZs)',
    'security group (default-deny)',
  ],
  service_identity: [
    'IAM role per resource',
    'short-lived credential issuer',
  ],
  managed_postgres: [
    'managed Postgres instance',
    'private VPC endpoint',
    'KMS-backed at-rest encryption',
    'automated backup schedule',
  ],
  private_object_store: [
    'object-storage bucket (private)',
    'SSE encryption configuration',
    'object-versioning policy',
    'lifecycle rule (noncurrent expiry)',
  ],
  managed_queue: [
    'managed queue',
    'dead-letter queue',
    'KMS-backed message encryption',
  ],
  managed_cache: [
    'managed in-memory cache (Redis)',
    'private VPC subnet group (no public endpoint)',
    'KMS at-rest + TLS in-transit encryption',
  ],
  secrets_manager: [
    'managed secret store',
    'KMS-backed encryption',
    'least-privilege resource policy',
    'automatic rotation policy',
  ],
  cdn: [
    'CDN distribution (CloudFront)',
    'HTTPS-only viewer policy (modern TLS floor)',
    'origin access control (private origin)',
  ],
  container_worker: [
    'containerised worker service',
    'autoscaling group (bounded)',
    'crash-restart policy',
  ],
  scheduler: [
    'managed scheduler rule',
    'idempotency key store',
  ],
  http_service: [
    'containerised HTTP service',
    'managed load balancer',
    'health-check + readiness probes',
  ],
  logs_metrics_pipeline: [
    'central log group',
    'metrics scraper config',
    'redaction filter for secret-shaped values',
  ],
};

// ---------------------------------------------------------------------------
// Public shape — what the route + UI consume.
// ---------------------------------------------------------------------------

export interface PreviewStep {
  step_id: string;
  layer: LayerId;
  module: InfraModuleId;
  module_label: string;
  // The resource_id from the InfraSpec when the step is resource-
  // specific; null for shared layer modules.
  resource_id: string | null;
  // Human-readable list of WHAT WOULD BE CREATED, drawn from the
  // RESOURCES_BY_MODULE table above. Bounded ≤ 10 entries per step.
  creates: ReadonlyArray<string>;
  // Monthly USD estimate for THIS step (sizing applied).
  estimated_usd_per_month: number;
  // Bounded sizing summary so the UI can show "× 3 instances" / "100 GB"
  // alongside the cost figure without re-parsing the plan config.
  sizing_summary: string | null;
  // Public-exposure opt-in flag, surfaced when the step is an
  // http_service whose InfraSpec config asked for `public: true`.
  public_exposure_opt_in: boolean;
}

export interface PreviewLayer {
  layer: LayerId;
  label: string;
  steps: ReadonlyArray<PreviewStep>;
  // Sum of step estimates within the layer — handy for the UI's
  // per-layer subtotal line.
  layer_usd_per_month: number;
}

export interface InfraPreviewResult {
  // Ordered layer buckets. Always includes every layer in the LAYER
  // order, even if empty, so the UI can render a stable structure.
  layers: ReadonlyArray<PreviewLayer>;
  // Aggregated cost figures.
  total_usd_per_month: number;
  total_usd_per_hour: number;
  // Per-module rolled-up totals for the cost-breakdown table.
  by_module: ReadonlyArray<{
    module: InfraModuleId;
    module_label: string;
    count: number;
    usd_per_month: number;
  }>;
  // Public-exposure opt-ins surfaced again at the preview level so
  // the UI can highlight them prominently next to the ceiling
  // verdict.
  public_exposure_opt_ins: ReadonlyArray<string>;
  // Plain-language summary: "X resources across N modules in M layers".
  summary: {
    resource_count: number;
    module_count: number;
    layer_count: number;
  };
}

export interface DerivePreviewInput {
  plan: ProvisioningPlan;
  // The InfraSpec's resource configs drive the public-exposure
  // opt-in detection (http_service.public). The plan step's config
  // is the projection-passing source for sizing.
  publicHttpServiceResourceIds: ReadonlyArray<string>;
}

// Pure, deterministic. Same input → byte-identical output every run.
export function deriveInfraPreview(
  input: DerivePreviewInput,
): InfraPreviewResult {
  const publicSet = new Set(input.publicHttpServiceResourceIds);

  const stepsByLayer = new Map<LayerId, PreviewStep[]>();
  for (const layer of ['network', 'data', 'compute', 'observability'] as const) {
    stepsByLayer.set(layer, []);
  }

  const moduleCounts = new Map<InfraModuleId, number>();
  const moduleCosts = new Map<InfraModuleId, number>();

  for (const step of input.plan.steps) {
    const preview = describeStep(step, publicSet);
    const bucket = stepsByLayer.get(step.layer);
    if (bucket) bucket.push(preview);

    moduleCounts.set(step.module, (moduleCounts.get(step.module) ?? 0) + 1);
    moduleCosts.set(
      step.module,
      (moduleCosts.get(step.module) ?? 0) + preview.estimated_usd_per_month,
    );
  }

  // Order each layer's steps by step id so the output is byte-stable.
  for (const arr of stepsByLayer.values()) {
    arr.sort((a, b) => (a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0));
  }

  // Stable layer ordering — even empty layers appear so the UI's
  // shape is uniform.
  const orderedLayers: PreviewLayer[] = (
    ['network', 'data', 'compute', 'observability'] as const
  )
    .slice()
    .sort((a, b) => LAYER_ORDER[a] - LAYER_ORDER[b])
    .map((layer) => {
      const steps = stepsByLayer.get(layer) ?? [];
      const layerCost = steps.reduce(
        (acc, s) => acc + s.estimated_usd_per_month,
        0,
      );
      return {
        layer,
        label: layerLabel(layer),
        steps,
        layer_usd_per_month: layerCost,
      };
    });

  const total = orderedLayers.reduce(
    (acc, l) => acc + l.layer_usd_per_month,
    0,
  );

  // by_module sorted alphabetically by module id so the breakdown
  // table reads stably.
  const byModule = Array.from(moduleCounts.keys())
    .sort()
    .map((m) => ({
      module: m,
      module_label: moduleById(m).label,
      count: moduleCounts.get(m) ?? 0,
      usd_per_month: moduleCosts.get(m) ?? 0,
    }));

  const resourceCount = orderedLayers.reduce(
    (acc, l) =>
      acc + l.steps.reduce((a, s) => a + s.creates.length, 0),
    0,
  );

  const publicOptIns: string[] = [];
  for (const l of orderedLayers) {
    for (const s of l.steps) {
      if (s.public_exposure_opt_in && s.resource_id) {
        publicOptIns.push(s.resource_id);
      }
    }
  }

  return {
    layers: orderedLayers,
    total_usd_per_month: round2(total),
    total_usd_per_hour: round4(monthlyToHourly(total)),
    by_module: byModule.map((m) => ({
      ...m,
      usd_per_month: round2(m.usd_per_month),
    })),
    public_exposure_opt_ins: publicOptIns,
    summary: {
      resource_count: resourceCount,
      module_count: moduleCounts.size,
      layer_count: orderedLayers.filter((l) => l.steps.length > 0).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-step description — pulls sizing out of the plan-step config in
// a typed way (config values are Zod-validated primitives, so we know
// the shape).
// ---------------------------------------------------------------------------

function describeStep(
  step: ProvisioningStep,
  publicSet: Set<string>,
): PreviewStep {
  const mod = moduleById(step.module);
  const instances = readNumber(step.config?.instances);
  const storageGb = readNumber(step.config?.storage_gb);
  const usd = estimateStepUsdPerMonth({
    module: step.module,
    instances,
    storage_gb: storageGb,
  });

  const publicOptIn =
    step.module === 'http_service' &&
    step.resource_id != null &&
    publicSet.has(step.resource_id);

  // Human-readable sizing summary. Bounded.
  const sizingBits: string[] = [];
  if (
    (step.module === 'container_worker' || step.module === 'http_service') &&
    instances != null
  ) {
    sizingBits.push('× ' + instances + ' instance' + (instances === 1 ? '' : 's'));
  }
  if (
    (step.module === 'managed_postgres' ||
      step.module === 'private_object_store') &&
    storageGb != null
  ) {
    sizingBits.push(storageGb + ' GB');
  }

  return {
    step_id: step.id,
    layer: step.layer,
    module: step.module,
    module_label: mod.label,
    resource_id: step.resource_id,
    creates: RESOURCES_BY_MODULE[step.module],
    estimated_usd_per_month: round2(usd),
    sizing_summary: sizingBits.length > 0 ? sizingBits.join(' · ') : null,
    public_exposure_opt_in: publicOptIn,
  };
}

function readNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function layerLabel(layer: LayerId): string {
  switch (layer) {
    case 'network':
      return 'Network & identity';
    case 'data':
      return 'Data stores & queues';
    case 'compute':
      return 'Workloads & schedulers';
    case 'observability':
      return 'Observability wiring';
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
