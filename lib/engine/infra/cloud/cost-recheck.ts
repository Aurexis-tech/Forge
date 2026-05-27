// Real-plan COST RE-CHECK for Phase 4-5a.
//
// The P4-4 preview's cost estimate was derived from the catalog +
// the composed plan steps (pre-cloud). P4-5a runs a REAL
// `terraform plan` and may surface a different cost shape — extra
// resources from drift, more instances than the catalog assumed,
// state already imported, etc. Before the gate fires we re-evaluate
// the cost ceiling against the REAL plan diff.
//
// MAPPING:
//   - Every PlannedResource carries its `module` (the first segment
//     of "module.<id>.<...>"). We look up the catalog module id from
//     the InfraModule catalog, then use the P4-4 pricing table to
//     estimate a per-resource monthly USD.
//   - When the address sits OUTSIDE any catalog module (`module ===
//     null`), the resource is treated as `unknown-resource` — its
//     cost is set to the closest-matching catalog module by
//     Terraform `type` heuristics, with a conservative high default
//     when nothing matches. The destructive flag covers the gate;
//     the cost-recheck just keeps the number from going to zero.
//   - DESTROY actions subtract the resource's monthly cost (the
//     resource is going away). CHANGE / REPLACE are billed at the
//     full month — Terraform doesn't tell us the per-resource cost
//     delta and we'd rather over-estimate than under.
//   - NO-OP resources contribute zero.
//
// This module is PURE — no DB, no cloud, no LLM. The route layer
// passes a fresh InfraPlanDiff in and the ceiling evaluator runs
// against the returned figure.

import type {
  InfraPlanDiff,
  PlannedResource,
} from './provider';
import type { InfraModuleId } from '@/lib/engine/infra/planner/modules';
import { estimateStepUsdPerMonth } from '@/lib/engine/infra/preview/pricing';

// Heuristic mapping from Terraform `type` to a catalog InfraModuleId
// for resources whose module address didn't resolve. Closed and
// conservative — when nothing matches we attribute the cost to the
// most expensive single-module figure in the catalog so the cost-
// recheck errs toward blocking.
const TYPE_HEURISTIC: ReadonlyArray<{ re: RegExp; module: InfraModuleId }> = [
  { re: /^aws_(rds|db|aurora)/i, module: 'managed_postgres' },
  { re: /^aws_s3/i, module: 'private_object_store' },
  { re: /^aws_sqs/i, module: 'managed_queue' },
  { re: /^aws_(ecs|fargate)/i, module: 'container_worker' },
  { re: /^aws_(lambda|cloudwatch_event)/i, module: 'scheduler' },
  { re: /^aws_(lb|alb|nlb|apigatewayv2|cloudfront)/i, module: 'http_service' },
  { re: /^aws_(vpc|subnet|security_group|route)/i, module: 'private_network' },
  { re: /^aws_iam/i, module: 'service_identity' },
  { re: /^(aws_cloudwatch|aws_logs)/i, module: 'logs_metrics_pipeline' },
];

const CATALOG_IDS: ReadonlyArray<InfraModuleId> = [
  'private_network',
  'service_identity',
  'managed_postgres',
  'private_object_store',
  'managed_queue',
  'container_worker',
  'scheduler',
  'http_service',
  'logs_metrics_pipeline',
];

export interface PlanCostBreakdown {
  // Total monthly USD attributed to the real plan diff. Always >= 0
  // (destroys subtract, but capped at zero).
  total_usd_per_month: number;
  // Per-catalog-module breakdown, sorted by module id for stable
  // output. Counts include CREATE + CHANGE + REPLACE; DESTROY
  // shows as negative cost.
  by_module: ReadonlyArray<{
    module: InfraModuleId | 'unknown-resource';
    create: number;
    change: number;
    replace: number;
    destroy: number;
    usd_per_month_delta: number;
  }>;
}

export function estimatePlanCostUsdPerMonth(
  diff: InfraPlanDiff,
): PlanCostBreakdown {
  type Bucket = {
    create: number;
    change: number;
    replace: number;
    destroy: number;
    usd_per_month_delta: number;
  };
  const buckets = new Map<InfraModuleId | 'unknown-resource', Bucket>();

  for (const r of diff.resources) {
    const moduleId = resolveModule(r);
    const bucket =
      buckets.get(moduleId) ??
      ({
        create: 0,
        change: 0,
        replace: 0,
        destroy: 0,
        usd_per_month_delta: 0,
      } as Bucket);

    // Sizing: we don't have it from the plan diff alone (Terraform's
    // -json plan carries config values but the schema varies per
    // provider). Use the catalog default (1 instance, base storage).
    const perResourceUsd =
      moduleId === 'unknown-resource'
        ? // Conservative fallback — pick the most expensive base.
          MAX_CATALOG_BASE_USD
        : estimateStepUsdPerMonth({ module: moduleId });

    switch (r.action) {
      case 'create':
        bucket.create++;
        bucket.usd_per_month_delta += perResourceUsd;
        break;
      case 'change':
        bucket.change++;
        // CHANGE doesn't change the bill of materials; the catalog
        // estimate is unchanged. Contribute the full month because we
        // can't tell which way the change goes. Conservative.
        bucket.usd_per_month_delta += perResourceUsd;
        break;
      case 'replace':
        bucket.replace++;
        bucket.usd_per_month_delta += perResourceUsd;
        break;
      case 'destroy':
        bucket.destroy++;
        bucket.usd_per_month_delta -= perResourceUsd;
        break;
      case 'no-op':
        // No contribution.
        break;
    }

    buckets.set(moduleId, bucket);
  }

  // Compute the total — clamp at zero so a destroy-heavy plan
  // doesn't return a negative cost (the ceiling check would treat a
  // negative figure as "no spend").
  let total = 0;
  for (const b of buckets.values()) {
    total += b.usd_per_month_delta;
  }
  total = Math.max(0, total);

  const byModule = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([module, bucket]) => ({
      module,
      ...bucket,
      usd_per_month_delta: round2(bucket.usd_per_month_delta),
    }));

  return {
    total_usd_per_month: round2(total),
    by_module: byModule,
  };
}

function resolveModule(r: PlannedResource): InfraModuleId | 'unknown-resource' {
  if (r.module && (CATALOG_IDS as ReadonlyArray<string>).includes(r.module)) {
    return r.module as InfraModuleId;
  }
  for (const { re, module } of TYPE_HEURISTIC) {
    if (re.test(r.type)) return module;
  }
  return 'unknown-resource';
}

// Conservative fallback — the priciest single catalog base figure.
// Picked at module init so the value tracks any catalog edit.
const MAX_CATALOG_BASE_USD: number = Math.max(
  ...CATALOG_IDS.map((id) =>
    estimateStepUsdPerMonth({ module: id, instances: 1 }),
  ),
);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
