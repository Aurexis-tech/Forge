// The deterministic IaC composer.
//
// Turns an approved ProvisioningPlan into a tree of Terraform files by
// COMPOSING vetted catalog modules. ZERO freehand resource emission —
// every block in the output traces to an `IAC_CATALOG` module address.
// NO LLM involvement at any step.
//
// FILE LAYOUT — one provider/version block, then one .tf file per
// step grouped under its layer directory:
//
//   infra/
//     versions.tf                — terraform required_providers + version
//     network/private_network.tf — module "private_network" { ... }
//     network/service_identity.tf
//     data/<step_id>.tf
//     compute/<step_id>.tf
//     observability/observability_pipeline.tf
//
// Each .tf file opens with a `# === aurexis-forge ===` comment block
// that:
//   - names the source module + version (audit trail)
//   - lists the SECURE DEFAULTS the module guarantees (private_by_default,
//     TLS, least_privilege_iam, kms_encryption) so a human reviewer
//     sees them without chasing the registry
//   - flags any public_exposure_opt_in (currently only http_service
//     when the spec config opts in)
//
// SECURE-DEFAULT INVARIANTS the composer enforces structurally:
//   1. http_service.public is FALSE unless the resource's InfraSpec
//      config explicitly set `public: true`. Anything else → private.
//   2. Inputs are whitelisted per catalog entry. Unknown plan-step
//      config keys are SILENTLY DROPPED. This means a malformed plan
//      can't smuggle in an unvetted variable.
//   3. The composer never writes a `resource "..."` block. Only
//      `module "..." { source = "aurexis-forge/.../composable" }`.
//
// The output is plain text — no execution, no `terraform init`, no
// network call. The static validator (validate.ts) parses the same
// text we produce and asserts structure.

import type {
  ProvisioningPlan,
  ProvisioningStep,
} from '@/lib/engine/infra/planner/schema';
import type { InfraSpec } from '@/lib/engine/infra/spec';
import {
  IAC_CATALOG,
  iacModuleSpec,
  type IacModuleSpec,
} from './catalog';
import type { InfraModuleId } from '@/lib/engine/infra/planner/modules';

export interface IacFile {
  path: string;
  content: string;
  // For build_files.source — every IaC file lands as 'scaffold' since
  // it's composed deterministically (no LLM round). The existing
  // BuildFile shape only knows 'scaffold' | 'generated'; we mark
  // module-instantiations as 'scaffold'.
  source: 'scaffold';
  bytes: number;
}

export interface IacComposeSummary {
  files: IacFile[];
  // The set of unique module ids present in the output. Used by the
  // test to assert "every emitted block traces to a catalog module".
  module_ids_used: ReadonlyArray<InfraModuleId>;
  // Per-step diagnostics for the audit log.
  steps_composed: ReadonlyArray<{
    step_id: string;
    layer: string;
    module: InfraModuleId;
    resource_id: string | null;
    path: string;
  }>;
  // Aggregated secure-default summary across the whole composition.
  // Computed by AND-ing the per-module flags. Surfaced verbatim in the
  // UI's SECURE-DEFAULTS strip + asserted in the dry-run test.
  secure_defaults: {
    private_by_default: boolean;
    tls: boolean;
    least_privilege_iam: boolean;
    kms_encryption: boolean;
  };
  // Public-exposure opt-ins. Empty array = nothing public. Otherwise
  // a list of resource ids that explicitly requested it via the spec.
  // The downstream P4-5 (provision/apply) gate surfaces these as a
  // typed destructive-confirm warning.
  public_exposure_opt_ins: ReadonlyArray<string>;
}

export class IacComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IacComposeError';
  }
}

const VERSIONS_TF = `# === aurexis-forge ===
# Pinned provider versions. The vetted module catalog targets these
# providers; bumping major requires a deliberate catalog version bump.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.30"
    }
  }
}
`;

export interface ComposeIacInput {
  spec: InfraSpec;
  plan: ProvisioningPlan;
}

// Single-entry composer. Walks the plan's steps IN EXECUTION ORDER and
// emits one Terraform file per step, plus a single versions.tf at the
// top. Wiring (downstream → upstream output references) is resolved
// deterministically by matching the step's depends_on against the
// upstream step's catalog outputs.
export function composeIac(input: ComposeIacInput): IacComposeSummary {
  const { spec, plan } = input;

  const files: IacFile[] = [];
  const moduleIdsUsed = new Set<InfraModuleId>();
  const stepsComposed: Array<{
    step_id: string;
    layer: string;
    module: InfraModuleId;
    resource_id: string | null;
    path: string;
  }> = [];
  const publicOptIns: string[] = [];

  // 1) versions.tf — always emitted at the top.
  files.push({
    path: 'infra/versions.tf',
    content: VERSIONS_TF,
    source: 'scaffold',
    bytes: VERSIONS_TF.length,
  });

  // Index the steps by id for upstream-output resolution.
  const stepById = new Map<string, ProvisioningStep>(
    plan.steps.map((s) => [s.id, s]),
  );

  // Iterate in execution_order so the file emission reads top-down
  // in build order naturally (matches the journey's "build-order
  // friendly" plan output).
  for (const stepId of plan.execution_order) {
    const step = stepById.get(stepId);
    if (!step) {
      throw new IacComposeError(
        'execution_order references unknown step id: ' + stepId,
      );
    }
    const mod = iacModuleSpec(step.module);
    moduleIdsUsed.add(step.module);

    // Detect public-exposure opt-in: only valid for http_service AND
    // only when the resource's InfraSpec config explicitly set
    // `public: true`. Anything else → forced private.
    let publicOptIn = false;
    if (step.module === 'http_service' && step.resource_id) {
      const resource = spec.resources.find((r) => r.id === step.resource_id);
      const requested = resource?.config?.public;
      if (requested === true) {
        publicOptIn = true;
        publicOptIns.push(step.resource_id);
      }
    }

    const tf = composeStep({
      step,
      mod,
      stepById,
      region: spec.region ?? null,
      publicOptIn,
    });
    const path = 'infra/' + step.layer + '/' + step.id + '.tf';
    files.push({
      path,
      content: tf,
      source: 'scaffold',
      bytes: tf.length,
    });
    stepsComposed.push({
      step_id: step.id,
      layer: step.layer,
      module: step.module,
      resource_id: step.resource_id,
      path,
    });
  }

  // Aggregate secure-default flags across every module used. AND
  // semantics — the composition's guarantee is the intersection of
  // its modules'. (In practice every catalog entry sets every flag
  // true, so the AND just confirms.)
  const secure_defaults = {
    private_by_default: true,
    tls: true,
    least_privilege_iam: true,
    kms_encryption: true,
  };
  for (const id of moduleIdsUsed) {
    const flags = IAC_CATALOG[id].secure_default_flags;
    if (!flags.private_by_default) secure_defaults.private_by_default = false;
    if (!flags.tls) secure_defaults.tls = false;
    if (!flags.least_privilege_iam) {
      secure_defaults.least_privilege_iam = false;
    }
    if (!flags.kms_encryption) secure_defaults.kms_encryption = false;
  }
  // KMS encryption is a DATA/COMPUTE layer guarantee — the network
  // layer modules (private_network, service_identity) deliberately
  // don't claim KMS (there's nothing to encrypt). For the AGGREGATE
  // summary, kms_encryption=true means "every module that COULD bake
  // it in did". So if any module that explicitly carries the flag
  // didn't, that's a regression. Re-aggregate over only modules whose
  // flag is meaningful:
  const kmsRelevant = Array.from(moduleIdsUsed).filter(
    (id) =>
      id !== 'private_network' &&
      id !== 'service_identity',
  );
  if (kmsRelevant.length > 0) {
    secure_defaults.kms_encryption = kmsRelevant.every(
      (id) => IAC_CATALOG[id].secure_default_flags.kms_encryption,
    );
  } else {
    // No KMS-relevant modules used → vacuously true.
    secure_defaults.kms_encryption = true;
  }

  return {
    files,
    module_ids_used: Array.from(moduleIdsUsed),
    steps_composed: stepsComposed,
    secure_defaults,
    public_exposure_opt_ins: publicOptIns,
  };
}

// ---------------------------------------------------------------------------
// Per-step composer.
//
// Emits a single .tf file containing ONE `module "<step_id>"` block.
// Inputs are whitelisted by the catalog spec. Upstream outputs are
// wired via `module.<upstream_step_id>.<output_name>` references —
// resolved deterministically by matching the upstream module's
// declared outputs against the downstream module's expected wiring
// inputs (see WIRING_RULES below).
// ---------------------------------------------------------------------------

interface ComposeStepInput {
  step: ProvisioningStep;
  mod: IacModuleSpec;
  stepById: Map<string, ProvisioningStep>;
  region: string | null;
  publicOptIn: boolean;
}

// Wiring rules — for each module id, which upstream catalog outputs
// land in which input slot. Deterministic + closed; freehand wiring
// is not a code path.
//
// Format: targetModule → { downstreamInputName → upstreamOutputName }
// The composer walks `step.depends_on`, looks up the upstream step's
// module, and wires any matching output ↦ input pair.
const WIRING_RULES: Partial<
  Record<
    InfraModuleId,
    ReadonlyArray<{ upstream_output: string; downstream_input: string }>
  >
> = {
  managed_postgres: [
    { upstream_output: 'vpc_id', downstream_input: 'vpc_id' },
    { upstream_output: 'private_subnet_ids', downstream_input: 'subnet_ids' },
    {
      upstream_output: 'security_group_id',
      downstream_input: 'security_group_id',
    },
  ],
  private_object_store: [],
  managed_queue: [],
  // managed_cache is private-by-default: it attaches to the VPC + private
  // subnets + security group, exactly like the database. No public endpoint.
  managed_cache: [
    { upstream_output: 'vpc_id', downstream_input: 'vpc_id' },
    { upstream_output: 'private_subnet_ids', downstream_input: 'subnet_ids' },
    {
      upstream_output: 'security_group_id',
      downstream_input: 'security_group_id',
    },
  ],
  // secrets_manager is standalone — no upstream outputs to wire. Its secure
  // defaults (KMS + least-privilege resource policy) are baked into the module.
  secrets_manager: [],
  container_worker: [
    { upstream_output: 'vpc_id', downstream_input: 'vpc_id' },
    { upstream_output: 'private_subnet_ids', downstream_input: 'subnet_ids' },
    { upstream_output: 'identity_pool_id', downstream_input: 'identity_pool_id' },
    { upstream_output: 'endpoint', downstream_input: 'db_endpoint' },
    {
      upstream_output: 'connection_secret_arn',
      downstream_input: 'db_secret_arn',
    },
    { upstream_output: 'queue_arn', downstream_input: 'queue_arn' },
    { upstream_output: 'bucket_arn', downstream_input: 'bucket_arn' },
    { upstream_output: 'cache_endpoint', downstream_input: 'cache_endpoint' },
    { upstream_output: 'secret_arn', downstream_input: 'app_secret_arn' },
  ],
  http_service: [
    { upstream_output: 'vpc_id', downstream_input: 'vpc_id' },
    { upstream_output: 'private_subnet_ids', downstream_input: 'subnet_ids' },
    { upstream_output: 'identity_pool_id', downstream_input: 'identity_pool_id' },
    { upstream_output: 'endpoint', downstream_input: 'db_endpoint' },
    {
      upstream_output: 'connection_secret_arn',
      downstream_input: 'db_secret_arn',
    },
    { upstream_output: 'cache_endpoint', downstream_input: 'cache_endpoint' },
    { upstream_output: 'secret_arn', downstream_input: 'app_secret_arn' },
  ],
  // cdn fronts an origin it depends on via the spec topology: an
  // http_service (service_url) or an object store (bucket). The origin
  // stays private — origin access control is baked into the module.
  cdn: [
    { upstream_output: 'service_url', downstream_input: 'origin_url' },
    { upstream_output: 'bucket_name', downstream_input: 'origin_bucket' },
    { upstream_output: 'bucket_arn', downstream_input: 'origin_bucket_arn' },
  ],
  scheduler: [
    { upstream_output: 'service_name', downstream_input: 'target_service_name' },
  ],
  logs_metrics_pipeline: [
    // Logs/metrics module declares retention as a config input only;
    // it doesn't import upstream outputs by name. The dependency on
    // every prior step is satisfied at the Terraform level via the
    // implicit `depends_on` we always emit.
  ],
};

function composeStep(args: ComposeStepInput): string {
  const { step, mod, stepById, region, publicOptIn } = args;

  // Compute the wired-input map. The plan-step config + any wired
  // upstream outputs flow into the module block.
  const lines: string[] = [];

  // --- Comment header: source, version, secure defaults, wiring -----
  const flags = mod.secure_default_flags;
  lines.push('# === aurexis-forge ===');
  lines.push('# source : ' + mod.source);
  lines.push('# version: ' + mod.version);
  lines.push('# step   : ' + step.id + ' (layer: ' + step.layer + ')');
  if (step.resource_id) {
    lines.push('# resource: ' + step.resource_id);
  }
  lines.push('# secure_defaults:');
  lines.push(
    '#   private_by_default = ' + String(flags.private_by_default),
  );
  lines.push('#   tls = ' + String(flags.tls));
  lines.push(
    '#   least_privilege_iam = ' + String(flags.least_privilege_iam),
  );
  lines.push('#   kms_encryption = ' + String(flags.kms_encryption));
  if (publicOptIn) {
    lines.push('# public_exposure_opt_in: true (requested by InfraSpec config)');
  }
  lines.push('');

  // --- module block --------------------------------------------------
  lines.push('module "' + step.id + '" {');
  lines.push('  source  = "' + mod.source + '"');
  lines.push('  version = "' + mod.version + '"');

  // Inputs: merge whitelisted plan-step config + region (if module
  // wants it) + wired upstream outputs.
  const inputs: Record<string, string> = {};

  // Region — only inject when the module accepts it AND the spec
  // declared one.
  if (mod.inputs.includes('region') && region) {
    inputs.region = quote(region);
  }

  // Whitelisted plan-step config keys.
  for (const key of mod.inputs) {
    if (key === 'region') continue; // already handled
    const raw = step.config?.[key];
    if (raw === undefined || raw === null) continue;
    inputs[key] = renderTfValue(raw);
  }

  // http_service `public` input — only set true if the spec opted in.
  // Otherwise force false. This is the structural enforcement of the
  // private-by-default guarantee.
  if (step.module === 'http_service') {
    inputs.public = publicOptIn ? 'true' : 'false';
  }

  // Wire upstream outputs into the right input slot.
  const wiringRules = WIRING_RULES[step.module] ?? [];
  if (wiringRules.length > 0) {
    for (const dep of step.depends_on) {
      const upstream = stepById.get(dep);
      if (!upstream) continue;
      const upstreamMod = iacModuleSpec(upstream.module);
      for (const rule of wiringRules) {
        if (!upstreamMod.outputs.includes(rule.upstream_output)) continue;
        // First-match wins — wiring is deterministic.
        if (inputs[rule.downstream_input]) continue;
        inputs[rule.downstream_input] =
          'module.' + upstream.id + '.' + rule.upstream_output;
      }
    }
  }

  // Sorted output for deterministic file content (test-friendly).
  const inputKeys = Object.keys(inputs).sort();
  for (const k of inputKeys) {
    lines.push('  ' + k.padEnd(20) + ' = ' + inputs[k]);
  }

  // Explicit depends_on — Terraform infers it from references, but we
  // also emit it to make build order legible to a human reading the
  // .tf file directly. Bounded by the plan step's depends_on list.
  if (step.depends_on.length > 0) {
    lines.push('');
    lines.push('  depends_on = [');
    for (const dep of step.depends_on) {
      lines.push('    module.' + dep + ',');
    }
    lines.push('  ]');
  }

  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function quote(s: string): string {
  // Terraform string escaping — backslash + double-quote only.
  // Plan config is bounded by Zod (max 400 chars, primitive strings)
  // so no other shell-escape surface is in play.
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function renderTfValue(value: unknown): string {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => renderTfValue(v)).join(', ') + ']';
  }
  // Closed value type via Zod (string | number | boolean | null | string[])
  // — null lands here, render as Terraform null.
  return 'null';
}
