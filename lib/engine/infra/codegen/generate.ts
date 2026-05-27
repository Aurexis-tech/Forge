// Top-level orchestrator for Phase 4 (Infrastructure) IaC generation.
//
// Composes the closed module catalog (compose.ts) → statically
// validates the output (validate.ts) → returns a summary the route +
// persistence helpers can write straight into build_files + the
// audit log.
//
// FULLY DETERMINISTIC — no LLM round, no governance ledger event for
// model spend. The route layer's `assertAllowed` still fires (kill
// switch + budget headroom check); but there's no compute to bill.
//
// STRUCTURAL NON-NEGOTIABLES (asserted by validateGeneratedIac):
//
//   1. Every emitted resource traces to a catalog module
//      (no freehand `resource "..."` or `data "..."` blocks).
//   2. Secure defaults present: private-by-default, TLS, least-
//      privilege IAM, KMS encryption — all carried by the modules.
//   3. NOTHING IS APPLIED — only code + static parse. NO
//      `terraform plan` / `apply` is invoked. NO cloud-provider API
//      is contacted.

import type { ProvisioningPlan } from '@/lib/engine/infra/planner/schema';
import type { InfraSpec } from '@/lib/engine/infra/spec';
import type { InfraModuleId } from '@/lib/engine/infra/planner/modules';
import { composeIac, IacComposeError, type IacFile } from './compose';
import { validateGeneratedIac, type IacFileValidation } from './validate';

export class InfraCodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfraCodegenError';
  }
}

export interface InfraCodegenSummary {
  files: IacFile[];
  // Per-file static check results (used to populate builds.logs.static_checks).
  static_checks: IacFileValidation[];
  // Top-level structural pass/fail.
  structural_ok: boolean;
  // Module ids actually instantiated. Asserted by the test to confirm
  // every emitted block traces to a catalog id.
  module_ids_used: ReadonlyArray<InfraModuleId>;
  // Layer counts for the UI's file tree grouping.
  files_by_layer: {
    network: number;
    data: number;
    compute: number;
    observability: number;
    versions: number;
  };
  // Public-exposure opt-ins (resource ids that explicitly set
  // `public: true` in spec config). Empty = nothing public.
  public_exposure_opt_ins: ReadonlyArray<string>;
  // Aggregated secure-default flags surfaced to the UI strip.
  secure_defaults: {
    private_by_default: boolean;
    tls: boolean;
    least_privilege_iam: boolean;
    kms_encryption: boolean;
  };
  // Plan-step → file map for the audit log.
  steps_composed: ReadonlyArray<{
    step_id: string;
    layer: string;
    module: InfraModuleId;
    resource_id: string | null;
    path: string;
  }>;
}

export interface GenerateInfraCodeInput {
  spec: InfraSpec;
  plan: ProvisioningPlan;
}

export function generateInfraCode(
  input: GenerateInfraCodeInput,
): InfraCodegenSummary {
  let composed;
  try {
    composed = composeIac({ spec: input.spec, plan: input.plan });
  } catch (err) {
    if (err instanceof IacComposeError) {
      throw new InfraCodegenError('iac compose failed: ' + err.message);
    }
    throw err;
  }

  const validation = validateGeneratedIac({
    plan: input.plan,
    files: composed.files,
  });

  // Count files per layer for the UI summary.
  const filesByLayer = {
    network: 0,
    data: 0,
    compute: 0,
    observability: 0,
    versions: 0,
  };
  for (const f of composed.files) {
    if (f.path === 'infra/versions.tf') {
      filesByLayer.versions++;
      continue;
    }
    if (f.path.startsWith('infra/network/')) filesByLayer.network++;
    else if (f.path.startsWith('infra/data/')) filesByLayer.data++;
    else if (f.path.startsWith('infra/compute/')) filesByLayer.compute++;
    else if (f.path.startsWith('infra/observability/')) {
      filesByLayer.observability++;
    }
  }

  return {
    files: composed.files,
    static_checks: validation.files,
    structural_ok: validation.ok,
    module_ids_used: composed.module_ids_used,
    files_by_layer: filesByLayer,
    public_exposure_opt_ins: composed.public_exposure_opt_ins,
    secure_defaults: composed.secure_defaults,
    steps_composed: composed.steps_composed,
  };
}
