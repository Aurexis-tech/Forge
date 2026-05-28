// Three gap-filling infra modules — managed_cache, secrets_manager, cdn.
//
// Infra is the SAFEST mold: codegen is fully DETERMINISTIC (zero LLM), so
// correctness + SECURE-BY-DEFAULT are entirely hermetically provable. This
// test proves, for each new module:
//   - registered in BOTH closed catalogs (planner + IaC) + priced
//   - SECURE DEFAULTS baked in (encryption + private + least-privilege +
//     TLS) — the centerpiece, the infra analog of RLS isolation
//   - generates BYTE-IDENTICAL deterministic IaC (no LLM variance)
//   - cost estimate produced; inputs/outputs validated
//   - flows through the existing compose + preview machinery unchanged
//   - "no freehand infra": only `module "..."` blocks, never raw `resource`

import { describe, expect, it } from 'vitest';
import { InfraSpecSchema, type InfraSpec } from '@/lib/engine/infra/spec';
import {
  INFRA_MODULES,
  MODULE_BY_RESOURCE,
  moduleById,
  type InfraModuleId,
} from '@/lib/engine/infra/planner/modules';
import { IAC_CATALOG, iacModuleSpec } from '@/lib/engine/infra/codegen/catalog';
import { composeIac } from '@/lib/engine/infra/codegen/compose';
import { deriveInfraGraph } from '@/lib/engine/infra/planner/graph';
import {
  ProvisioningPlanSchema,
  type ProvisioningPlan,
} from '@/lib/engine/infra/planner/schema';
import { deriveInfraPreview } from '@/lib/engine/infra/preview/derive';
import {
  estimateStepUsdPerMonth,
  moduleBaseUsdPerMonth,
  PRICING_MANAGED_CACHE_USD_PER_MO,
  PRICING_SECRETS_MANAGER_USD_PER_MO,
  PRICING_CDN_USD_PER_MO,
} from '@/lib/engine/infra/preview/pricing';

const NEW_MODULES = ['managed_cache', 'secrets_manager', 'cdn'] as const;

// A spec exercising all three new modules + their wiring: a worker that
// reads the cache + secrets, a CDN fronting an http_service.
function newModulesSpec(): InfraSpec {
  return InfraSpecSchema.parse({
    goal: 'Cache + secrets + CDN coverage.',
    region: 'us-east-1',
    lifecycle: 'persistent',
    resources: [
      { id: 'app_cache', type: 'cache', config: { node_type: 'small' } },
      { id: 'app_secrets', type: 'secret_store', config: { rotation_days: 30 } },
      { id: 'api', type: 'http_service', config: { image: 'aurexis/api:1', cpu: 1, memory_mb: 512 } },
      { id: 'edge', type: 'cdn', config: { price_class: '100' } },
      { id: 'worker', type: 'worker', config: { image: 'aurexis/worker:1', cpu: 1, memory_mb: 512 } },
    ],
    topology: [
      { from: 'worker', to: 'app_cache' },
      { from: 'worker', to: 'app_secrets' },
      { from: 'edge', to: 'api' }, // cdn fronts the http_service origin
    ],
  });
}

function planFromSpec(spec: InfraSpec): ProvisioningPlan {
  const derived = deriveInfraGraph(spec);
  return ProvisioningPlanSchema.parse({
    catalog_version: 'v1',
    steps: derived.steps.map((s) => ({
      id: s.id,
      layer: s.layer,
      module: s.module,
      description: s.description,
      depends_on: s.depends_on,
      config: s.config,
      resource_id: s.resource_id,
      secure_defaults: s.secure_defaults,
    })),
    execution_order: derived.executionOrder,
    warnings: [],
  });
}

// ===========================================================================
// CLOSED CATALOG REGISTRATION
// ===========================================================================
describe('the 3 new modules are registered in the closed catalog', () => {
  it('each appears in INFRA_MODULES, IAC_CATALOG, MODULE_BY_RESOURCE', () => {
    for (const id of NEW_MODULES) {
      expect(INFRA_MODULES.some((m) => m.id === id)).toBe(true);
      expect(IAC_CATALOG[id]).toBeDefined();
      expect(moduleById(id).id).toBe(id);
    }
    expect(MODULE_BY_RESOURCE.cache).toBe('managed_cache');
    expect(MODULE_BY_RESOURCE.secret_store).toBe('secrets_manager');
    expect(MODULE_BY_RESOURCE.cdn).toBe('cdn');
  });

  it('an unknown module id is rejected (structural enum / closed catalog)', () => {
    expect(() => iacModuleSpec('magic_cloud' as InfraModuleId)).toThrow();
    expect(() => moduleById('magic_cloud' as InfraModuleId)).toThrow();
    // The plan schema's module enum rejects it at the boundary too.
    const bad = ProvisioningPlanSchema.safeParse({
      catalog_version: 'v1',
      steps: [{ id: 'x', layer: 'data', module: 'magic_cloud', description: 'd', depends_on: [], config: {}, resource_id: null, secure_defaults: [] }],
      execution_order: ['x'],
      warnings: [],
    });
    expect(bad.success).toBe(false);
  });
});

// ===========================================================================
// SECURE DEFAULTS — the centerpiece. Encryption + private + least-privilege
// are baked into the catalog flags, never optional, never LLM-decided.
// ===========================================================================
describe('SECURE DEFAULTS are baked into every new module', () => {
  it('each catalog entry enables encryption + private + least-privilege + TLS', () => {
    for (const id of NEW_MODULES) {
      const flags = IAC_CATALOG[id].secure_default_flags;
      expect(flags.kms_encryption, id + ' must encrypt at rest').toBe(true);
      expect(flags.private_by_default, id + ' must be private by default').toBe(true);
      expect(flags.least_privilege_iam, id + ' must be least-privilege').toBe(true);
      expect(flags.tls, id + ' must use TLS').toBe(true);
    }
  });

  it('the planner module declares secure-default intent (encryption/private/least-priv)', () => {
    const cache = moduleById('managed_cache');
    expect(cache.secure_defaults.join(' ').toLowerCase()).toMatch(/encryption/);
    expect(cache.secure_defaults.join(' ').toLowerCase()).toMatch(/private|no public/);
    const secrets = moduleById('secrets_manager');
    expect(secrets.secure_defaults.join(' ').toLowerCase()).toMatch(/least-privilege/);
    expect(secrets.secure_defaults.join(' ').toLowerCase()).toMatch(/encrypted|kms/);
    const cdn = moduleById('cdn');
    expect(cdn.secure_defaults.join(' ').toLowerCase()).toMatch(/https-only|tls/);
    expect(cdn.secure_defaults.join(' ').toLowerCase()).toMatch(/private origin/);
  });

  it('the COMPOSED IaC surfaces the secure defaults + the aggregate stays secure', () => {
    const spec = newModulesSpec();
    const summary = composeIac({ spec, plan: planFromSpec(spec) });
    // Aggregate secure-default summary is fully secure.
    expect(summary.secure_defaults).toEqual({
      private_by_default: true,
      tls: true,
      least_privilege_iam: true,
      kms_encryption: true,
    });
    // No public-exposure opt-ins (no http_service asked for public).
    expect(summary.public_exposure_opt_ins).toEqual([]);
    // Each new module's .tf carries the secure-defaults comment block.
    const byPath = new Map(summary.files.map((f) => [f.path, f.content]));
    const cacheTf = byPath.get('infra/data/data_app_cache.tf')!;
    expect(cacheTf).toMatch(/#\s*kms_encryption\s*=\s*true/);
    expect(cacheTf).toMatch(/#\s*private_by_default\s*=\s*true/);
    expect(cacheTf).toMatch(/#\s*least_privilege_iam\s*=\s*true/);
    const secretsTf = byPath.get('infra/data/data_app_secrets.tf')!;
    expect(secretsTf).toMatch(/#\s*kms_encryption\s*=\s*true/);
    const cdnTf = byPath.get('infra/compute/compute_edge.tf')!;
    expect(cdnTf).toMatch(/#\s*tls\s*=\s*true/);
    expect(cdnTf).toMatch(/#\s*private_by_default\s*=\s*true/);
  });
});

// ===========================================================================
// DETERMINISTIC IaC — "no freehand infra" (byte-identical, zero LLM)
// ===========================================================================
describe('deterministic IaC generation (no LLM variance)', () => {
  it('the same spec produces BYTE-IDENTICAL composed files across runs', () => {
    const spec = newModulesSpec();
    const a = composeIac({ spec, plan: planFromSpec(spec) });
    const b = composeIac({ spec, plan: planFromSpec(spec) });
    expect(a.files).toEqual(b.files);
    expect([...a.module_ids_used].sort()).toEqual([...b.module_ids_used].sort());
  });

  it('every emitted block is a vetted catalog `module` — never a raw `resource`', () => {
    const spec = newModulesSpec();
    const summary = composeIac({ spec, plan: planFromSpec(spec) });
    for (const id of NEW_MODULES) {
      expect(summary.module_ids_used).toContain(id);
    }
    for (const f of summary.files) {
      // Deterministic composer NEVER writes a freehand `resource "..."` block.
      expect(f.content).not.toMatch(/^\s*resource\s+"/m);
    }
    // The new-module files point at the vetted registry source.
    const byPath = new Map(summary.files.map((f) => [f.path, f.content]));
    expect(byPath.get('infra/data/data_app_cache.tf')).toContain(IAC_CATALOG.managed_cache.source);
    expect(byPath.get('infra/data/data_app_secrets.tf')).toContain(IAC_CATALOG.secrets_manager.source);
    expect(byPath.get('infra/compute/compute_edge.tf')).toContain(IAC_CATALOG.cdn.source);
  });

  it('inputs are whitelisted + upstream outputs wired deterministically', () => {
    const spec = newModulesSpec();
    const summary = composeIac({ spec, plan: planFromSpec(spec) });
    const byPath = new Map(summary.files.map((f) => [f.path, f.content]));
    // The worker consumes the cache endpoint + secret arn via wiring
    // (whitespace-insensitive — the composer pads input keys).
    const workerTf = byPath.get('infra/compute/compute_worker.tf')!;
    expect(workerTf).toMatch(/cache_endpoint\s*=\s*module\.data_app_cache\.cache_endpoint/);
    expect(workerTf).toMatch(/app_secret_arn\s*=\s*module\.data_app_secrets\.secret_arn/);
    // The CDN wires its origin from the http_service it fronts.
    const cdnTf = byPath.get('infra/compute/compute_edge.tf')!;
    expect(cdnTf).toMatch(/origin_url\s*=\s*module\.compute_api\.service_url/);
  });
});

// ===========================================================================
// COST ESTIMATE
// ===========================================================================
describe('cost estimate produced for each new module', () => {
  it('estimateStepUsdPerMonth returns the catalog base for each', () => {
    expect(estimateStepUsdPerMonth({ module: 'managed_cache' })).toBe(PRICING_MANAGED_CACHE_USD_PER_MO);
    expect(estimateStepUsdPerMonth({ module: 'secrets_manager' })).toBe(PRICING_SECRETS_MANAGER_USD_PER_MO);
    expect(estimateStepUsdPerMonth({ module: 'cdn' })).toBe(PRICING_CDN_USD_PER_MO);
    for (const id of NEW_MODULES) {
      expect(moduleBaseUsdPerMonth(id)).toBeGreaterThan(0);
    }
  });

  it('the preview totals the new modules into the monthly estimate', () => {
    const spec = newModulesSpec();
    const preview = deriveInfraPreview({
      plan: planFromSpec(spec),
      publicHttpServiceResourceIds: [],
    });
    // The total is at least the sum of the three new modules' bases.
    const newSum =
      PRICING_MANAGED_CACHE_USD_PER_MO +
      PRICING_SECRETS_MANAGER_USD_PER_MO +
      PRICING_CDN_USD_PER_MO;
    expect(preview.total_usd_per_month).toBeGreaterThanOrEqual(newSum);
    expect(preview.total_usd_per_hour).toBeGreaterThan(0);
  });
});

// ===========================================================================
// INTEGRATION — flows through the planner + compose + preview unchanged
// ===========================================================================
describe('new modules flow through the existing machinery', () => {
  it('a spec with cache/secret_store/cdn derives a valid acyclic plan', () => {
    const spec = newModulesSpec();
    const derived = deriveInfraGraph(spec);
    expect(derived.issues).toEqual([]);
    // The plan validates against the closed schema (module enum gate).
    const plan = planFromSpec(spec);
    expect(plan.steps.some((s) => s.module === 'managed_cache')).toBe(true);
    expect(plan.steps.some((s) => s.module === 'secrets_manager')).toBe(true);
    expect(plan.steps.some((s) => s.module === 'cdn')).toBe(true);
    // cache + secret_store land in the data layer; cdn in compute.
    expect(plan.steps.find((s) => s.module === 'managed_cache')!.layer).toBe('data');
    expect(plan.steps.find((s) => s.module === 'secrets_manager')!.layer).toBe('data');
    expect(plan.steps.find((s) => s.module === 'cdn')!.layer).toBe('compute');
  });
});

// ===========================================================================
// BACKWARD COMPAT
// ===========================================================================
describe('existing modules unaffected', () => {
  it('a spec using only the original resource types composes as before', () => {
    const spec = InfraSpecSchema.parse({
      goal: 'classic',
      region: 'us-east-1',
      lifecycle: 'persistent',
      resources: [{ id: 'db', type: 'postgres_db', config: { storage_gb: 20 } }],
      topology: [],
    });
    const summary = composeIac({ spec, plan: planFromSpec(spec) });
    expect(summary.module_ids_used).not.toContain('managed_cache');
    expect(summary.module_ids_used).not.toContain('secrets_manager');
    expect(summary.module_ids_used).not.toContain('cdn');
    expect(summary.secure_defaults.kms_encryption).toBe(true);
  });
});
