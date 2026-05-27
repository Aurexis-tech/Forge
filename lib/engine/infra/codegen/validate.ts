// Static IaC validator.
//
// Parses generated .tf files and asserts STRUCTURAL invariants WITHOUT
// invoking `terraform` itself. The Forge MUST NEVER:
//
//   - run `terraform init`, `terraform plan`, or `terraform apply`
//   - dispatch any cloud-provider API call
//   - hit the Terraform registry to resolve modules
//
// All three would constitute "applying" infrastructure, which is
// Phase 4-5's job behind a typed destructive-confirm gate. The
// generator (P4-3) MUST stop at code + a parse check.
//
// What this validator actually does:
//
//   1. Confirms every step in the plan produced exactly one .tf file
//      with one `module "..."` block.
//   2. Confirms the block source matches the catalog entry's source.
//   3. Confirms NO freehand `resource "..."` or `data "..."` block
//      exists in any generated file. The composer only emits
//      `module "..."` blocks; a stray resource block would be a
//      regression and the validator HARD FAILS the build.
//   4. Confirms the secure-defaults comment block is present on every
//      module file.
//   5. Confirms versions.tf is present + carries a `required_version`
//      pin.
//
// A failure here flips the build to 'failed' with a clear per-file
// reason; no plan/apply ever fires.

import type { ProvisioningPlan } from '@/lib/engine/infra/planner/schema';
import { iacModuleSpec } from './catalog';
import type { IacFile } from './compose';

export type IacValidationStatus = 'ok' | 'failed';

export interface IacFileValidation {
  path: string;
  status: IacValidationStatus;
  error?: string;
}

export interface IacValidationResult {
  ok: boolean;
  files: IacFileValidation[];
  // Top-level structural assertions (separate from per-file checks).
  structure: {
    versions_tf_present: boolean;
    no_freehand_resource_blocks: boolean;
    every_step_has_one_module_block: boolean;
    every_module_traces_to_catalog: boolean;
  };
}

const MODULE_BLOCK_RE = /^\s*module\s+"([a-z][a-z0-9_]*)"\s*\{/m;
// Detect ANY freehand resource/data block. The composer never emits
// these; their presence in generated output is a defect.
const FREEHAND_RESOURCE_RE = /^\s*resource\s+"[^"]+"\s+"[^"]+"\s*\{/m;
const FREEHAND_DATA_RE = /^\s*data\s+"[^"]+"\s+"[^"]+"\s*\{/m;
const SOURCE_RE = /^\s*source\s*=\s*"([^"]+)"\s*$/m;
const SECURE_DEFAULTS_COMMENT_RE = /^# secure_defaults:/m;

export function validateGeneratedIac(args: {
  plan: ProvisioningPlan;
  files: IacFile[];
}): IacValidationResult {
  const { plan, files } = args;
  const fileByPath = new Map(files.map((f) => [f.path, f]));

  const fileValidations: IacFileValidation[] = [];

  // --- 1. versions.tf -----------------------------------------------------
  const versionsTf = fileByPath.get('infra/versions.tf');
  const versionsPresent = Boolean(
    versionsTf && /required_version\s*=/m.test(versionsTf.content),
  );
  fileValidations.push({
    path: 'infra/versions.tf',
    status: versionsPresent ? 'ok' : 'failed',
    ...(versionsPresent
      ? {}
      : { error: 'missing or malformed versions.tf' }),
  });

  // --- 2. per-step .tf files ---------------------------------------------
  let everyStepHasOneModuleBlock = true;
  let everyModuleTracesToCatalog = true;
  let anyFreehand = false;

  for (const step of plan.steps) {
    const path = 'infra/' + step.layer + '/' + step.id + '.tf';
    const file = fileByPath.get(path);
    if (!file) {
      everyStepHasOneModuleBlock = false;
      fileValidations.push({
        path,
        status: 'failed',
        error: 'expected file is missing from the generated tree',
      });
      continue;
    }
    // Exactly one module block.
    const moduleBlockMatches = file.content.match(/^\s*module\s+"[^"]+"\s*\{/gm);
    if (!moduleBlockMatches || moduleBlockMatches.length !== 1) {
      everyStepHasOneModuleBlock = false;
      fileValidations.push({
        path,
        status: 'failed',
        error:
          'expected exactly one module {} block; found ' +
          (moduleBlockMatches?.length ?? 0),
      });
      continue;
    }
    // Module name matches step id.
    const nameMatch = MODULE_BLOCK_RE.exec(file.content);
    if (!nameMatch || nameMatch[1] !== step.id) {
      everyStepHasOneModuleBlock = false;
      fileValidations.push({
        path,
        status: 'failed',
        error:
          "module block name '" +
          (nameMatch?.[1] ?? '?') +
          "' does not match step id '" +
          step.id +
          "'",
      });
      continue;
    }
    // No freehand resource / data block.
    if (FREEHAND_RESOURCE_RE.test(file.content)) {
      anyFreehand = true;
      fileValidations.push({
        path,
        status: 'failed',
        error: 'freehand `resource "..."` block detected (composer regression)',
      });
      continue;
    }
    if (FREEHAND_DATA_RE.test(file.content)) {
      anyFreehand = true;
      fileValidations.push({
        path,
        status: 'failed',
        error: 'freehand `data "..."` block detected (composer regression)',
      });
      continue;
    }
    // Source matches the catalog entry.
    const sourceMatch = SOURCE_RE.exec(file.content);
    const expectedSource = iacModuleSpec(step.module).source;
    if (!sourceMatch || sourceMatch[1] !== expectedSource) {
      everyModuleTracesToCatalog = false;
      fileValidations.push({
        path,
        status: 'failed',
        error:
          "module source '" +
          (sourceMatch?.[1] ?? '?') +
          "' does not match catalog entry '" +
          expectedSource +
          "'",
      });
      continue;
    }
    // Secure-defaults comment is present.
    if (!SECURE_DEFAULTS_COMMENT_RE.test(file.content)) {
      fileValidations.push({
        path,
        status: 'failed',
        error: 'missing secure_defaults comment block',
      });
      continue;
    }
    fileValidations.push({ path, status: 'ok' });
  }

  // --- 3. Sweep every file for freehand blocks --------------------------
  // Already done per-file above for plan files; sweep again for any
  // straggler file the composer might emit (e.g. versions.tf would
  // count as freehand if a regression slipped one in).
  for (const f of files) {
    if (f.path === 'infra/versions.tf') {
      // versions.tf has no module block. Sanity-check it doesn't have
      // a freehand resource block either.
      if (FREEHAND_RESOURCE_RE.test(f.content) || FREEHAND_DATA_RE.test(f.content)) {
        anyFreehand = true;
        fileValidations.push({
          path: f.path,
          status: 'failed',
          error: 'versions.tf must not contain resource/data blocks',
        });
      }
      continue;
    }
  }

  const ok =
    versionsPresent &&
    everyStepHasOneModuleBlock &&
    everyModuleTracesToCatalog &&
    !anyFreehand &&
    fileValidations.every((v) => v.status === 'ok');

  return {
    ok,
    files: fileValidations,
    structure: {
      versions_tf_present: versionsPresent,
      no_freehand_resource_blocks: !anyFreehand,
      every_step_has_one_module_block: everyStepHasOneModuleBlock,
      every_module_traces_to_catalog: everyModuleTracesToCatalog,
    },
  };
}
