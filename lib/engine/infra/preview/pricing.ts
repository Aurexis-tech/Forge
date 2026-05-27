// ============================================================================
//          INFRASTRUCTURE PRICING — EDIT HERE BEFORE A REAL RUN
// ============================================================================
//
// Per-module monthly USD estimates for the closed catalog. Same shape
// as lib/engine/governance/pricing.ts (LLM + sandbox rates) — named
// constants per catalog entry, env-overridable, with deterministic
// helpers on top.
//
// The values below are CONSERVATIVE upper-bound estimates of a small-
// production deployment. They are deliberately not precise — the
// preview labels itself an ESTIMATE, not a quote, and the P4-5 confirm
// gate surfaces the same number to the user before any real apply.
// Verify against the cloud-provider pricing pages before going live.
//
// SIZING — for modules whose cost scales with `instances` (workers,
// http_services), the base figure is per-instance per-month and the
// estimator multiplies by `instances` (clamped 1..N from the plan).
// Modules whose cost scales with storage (postgres, object store)
// multiply the base by max(1, storage_gb / BASE_STORAGE_GB).
//
// Each constant can also be overridden at runtime via env var:
//
//   PRICING_INFRA_<MODULE_SLUG>_USD_PER_MO   USD/month for one unit
//
// <MODULE_SLUG> = module id uppercased (e.g. MANAGED_POSTGRES).

import type { InfraModuleId } from '@/lib/engine/infra/planner/modules';

// ---------------- Per-module monthly base cost (USD) ----------------------
//
// "Base" = one unit of the module at default sizing. Sizing
// multipliers apply on top (see estimateStepUsdPerMonth below).

export const PRICING_PRIVATE_NETWORK_USD_PER_MO: number = 10;
export const PRICING_SERVICE_IDENTITY_USD_PER_MO: number = 0;
export const PRICING_MANAGED_POSTGRES_USD_PER_MO: number = 60;
export const PRICING_PRIVATE_OBJECT_STORE_USD_PER_MO: number = 5;
export const PRICING_MANAGED_QUEUE_USD_PER_MO: number = 8;
export const PRICING_CONTAINER_WORKER_USD_PER_MO: number = 35;
export const PRICING_SCHEDULER_USD_PER_MO: number = 2;
export const PRICING_HTTP_SERVICE_USD_PER_MO: number = 40;
export const PRICING_LOGS_METRICS_PIPELINE_USD_PER_MO: number = 15;

// Sizing reference points — what the base figure covers.
export const POSTGRES_BASE_STORAGE_GB = 20;
export const OBJECT_STORE_BASE_STORAGE_GB = 100;

const INFRA_PRICING_TABLE: Record<InfraModuleId, number> = {
  private_network: PRICING_PRIVATE_NETWORK_USD_PER_MO,
  service_identity: PRICING_SERVICE_IDENTITY_USD_PER_MO,
  managed_postgres: PRICING_MANAGED_POSTGRES_USD_PER_MO,
  private_object_store: PRICING_PRIVATE_OBJECT_STORE_USD_PER_MO,
  managed_queue: PRICING_MANAGED_QUEUE_USD_PER_MO,
  container_worker: PRICING_CONTAINER_WORKER_USD_PER_MO,
  scheduler: PRICING_SCHEDULER_USD_PER_MO,
  http_service: PRICING_HTTP_SERVICE_USD_PER_MO,
  logs_metrics_pipeline: PRICING_LOGS_METRICS_PIPELINE_USD_PER_MO,
};

// ---------------- Helpers -------------------------------------------------

function envNum(name: string): number | null {
  const v = process.env[name];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function moduleSlug(id: InfraModuleId): string {
  return id.toUpperCase();
}

/**
 * Base monthly USD for a single unit of the given module. Honours an
 * env override of the form `PRICING_INFRA_<MODULE_SLUG>_USD_PER_MO`.
 */
export function moduleBaseUsdPerMonth(id: InfraModuleId): number {
  const env = envNum('PRICING_INFRA_' + moduleSlug(id) + '_USD_PER_MO');
  if (env != null) return env;
  return INFRA_PRICING_TABLE[id];
}

/**
 * Hours-in-a-month divisor used to surface the hourly figure in the UI.
 * 730 = 24 * 365.25 / 12, a steady value that doesn't drift across
 * months.
 */
export const HOURS_PER_MONTH = 730;

export function monthlyToHourly(usdPerMo: number): number {
  return usdPerMo / HOURS_PER_MONTH;
}

// ---------------- Per-step estimator --------------------------------------
//
// Reads bounded config from a ProvisioningStep (`instances`, `storage_gb`)
// and produces a per-step monthly USD figure. Pure function — same input
// produces the same output, deterministic-by-construction.

export interface StepCostInputs {
  module: InfraModuleId;
  // Bounded by the plan-step ConfigValueSchema (number primitive); the
  // estimator clamps to a sane upper bound so a hostile plan can't
  // produce a runaway estimate.
  instances?: number | null;
  storage_gb?: number | null;
}

const MAX_INSTANCES = 100;
const MAX_STORAGE_GB = 100_000;

export function estimateStepUsdPerMonth(args: StepCostInputs): number {
  const base = moduleBaseUsdPerMonth(args.module);

  switch (args.module) {
    case 'container_worker':
    case 'http_service': {
      const n = clamp(args.instances ?? 1, 1, MAX_INSTANCES);
      return base * n;
    }
    case 'managed_postgres': {
      const gb = clamp(
        args.storage_gb ?? POSTGRES_BASE_STORAGE_GB,
        POSTGRES_BASE_STORAGE_GB,
        MAX_STORAGE_GB,
      );
      const multiplier = gb / POSTGRES_BASE_STORAGE_GB;
      return base * multiplier;
    }
    case 'private_object_store': {
      const gb = clamp(
        args.storage_gb ?? OBJECT_STORE_BASE_STORAGE_GB,
        OBJECT_STORE_BASE_STORAGE_GB,
        MAX_STORAGE_GB,
      );
      const multiplier = gb / OBJECT_STORE_BASE_STORAGE_GB;
      return base * multiplier;
    }
    // Modules whose cost is a flat per-month figure regardless of sizing.
    case 'private_network':
    case 'service_identity':
    case 'managed_queue':
    case 'scheduler':
    case 'logs_metrics_pipeline':
      return base;
    default: {
      // The catalog is closed, but defensively cover any future addition.
      const _exhaustive: never = args.module;
      void _exhaustive;
      return base;
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
