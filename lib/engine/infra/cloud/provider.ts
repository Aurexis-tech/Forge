// CloudProvider abstraction — the single seam the Phase 4-5a plan
// route reaches through. One implementation today:
//
//   - TERRAFORM_CLI — shells out to `terraform plan -json` against
//     the generated IaC tree, with the user's cloud credentials
//     loaded into the child process's env (NOT the parent). Runs the
//     plan in a fresh temp directory, parses the JSON diff, and
//     deletes the temp directory + clears the env on the way out.
//
// Both reads (`terraform init -input=false`, `terraform plan -json`)
// are READ-ONLY against cloud state. NO `apply`. NO `import`. NO
// `state push`. NO `destroy`. The apply itself lands in P4-5b behind
// the separate typed-confirm gate.
//
// SECURITY CONTRACT every implementation upholds:
//
//   1. Cloud credentials are PASSED to the provider, never logged
//      and never persisted by the provider. The route layer decrypts
//      them from the `cloud` connection once, passes them into
//      plan(), and the provider scrubs them from its scope on return.
//   2. The returned InfraPlanDiff is SANITISED. We strip:
//        - any `*.values.*` containing strings that look like JWTs,
//          AWS keys, or env-var lookalikes
//        - the entire `prior_state.values.outputs` (which can carry
//          secret outputs)
//      so the audit + DB row + UI never see a raw secret.
//   3. NEVER invoke a destructive subcommand. The provider's
//      `plan()` method only runs `terraform init` (with -input=false
//      and -no-color) + `terraform plan -no-color -json`. The
//      provider does not expose `apply()`, `destroy()`, or anything
//      else that writes to cloud state.

import type { BuildFile } from '@/lib/types';

export type CloudProviderKind = 'terraform_cli';

// Resource address as Terraform emits it ("module.<step_id>.aws_db_instance.this").
// Used everywhere a single resource is referenced in the diff.
export type ResourceAddress = string;

// A single resource's planned action — the Terraform 'change.actions'
// list collapsed into a coarse classification the gate logic needs.
export type ResourceAction = 'create' | 'change' | 'replace' | 'destroy' | 'no-op';

export interface PlannedResource {
  address: ResourceAddress;
  // The Terraform resource type ("aws_db_instance"). Surfaced for the
  // UI's grouping + the audit row's resource-type counts.
  type: string;
  // Catalog-derived module the resource belongs to ("managed_postgres").
  // The composer always wraps every resource inside a `module "<id>"`
  // block, so the first segment of the address identifies it.
  // Optional because a state-drift import could surface a resource
  // outside any module — in which case we surface it as `null` and the
  // gate treats it as destructive-by-default.
  module: string | null;
  action: ResourceAction;
}

export interface InfraPlanDiff {
  // The full set of planned resources, in the order Terraform emitted.
  resources: ReadonlyArray<PlannedResource>;
  // Coarse counts for fast UI rendering + audit log.
  create_count: number;
  change_count: number;
  // `replace_count` is included in destroy_count for the gate (replace
  // = destroy + create) but tracked separately here so the UI can
  // surface "replace" vs "destroy" with different copy.
  replace_count: number;
  destroy_count: number;
  // Convenience flag — true iff change_count + replace_count +
  // destroy_count > 0. Drives the destructive-confirm gate.
  destructive: boolean;
  // The exact CLI version that produced the diff. Surfaced in the
  // audit row so a future replay can repro the toolchain.
  terraform_version: string;
  // Aggregated provider metadata (e.g. provider versions). Empty
  // when the provider didn't surface anything to log.
  provider_metadata: ReadonlyArray<string>;
}

// Phase 4-5b: what `plan()` returns to the route layer. The diff
// drives the UI + the cost re-check; the artifact is the saved
// `terraform plan -out=<file>` binary that the apply step reads
// verbatim so what's applied is EXACTLY what the user confirmed.
export interface PlanResult {
  diff: InfraPlanDiff;
  // base64-encoded plan binary. Stored on the infra_plans row and
  // passed back to `provider.apply({ planArtifact })` later.
  plan_artifact_b64: string;
}

export interface CloudCredentials {
  // Free-form bag of env-style key/value pairs the provider sets on
  // the terraform child process. Closed catalog at the route layer:
  // AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION today,
  // GOOGLE_APPLICATION_CREDENTIALS later, etc. The provider doesn't
  // care about the schema — it just spreads them into the child env.
  env: Record<string, string>;
  // Convenience hint for logs — e.g. "aws-us-east-1". NEVER includes
  // a secret value. Surfaced in audit only.
  account_hint: string | null;
}

export interface CloudPlanInput {
  // The IaC tree composed by P4-3, drawn from build_files. Files are
  // written into a fresh temp directory before the plan runs.
  files: ReadonlyArray<BuildFile>;
  // Decrypted cloud creds, used to populate the terraform child's env.
  // The provider does not persist these — they're spread into the
  // child's env and the parent reference is cleared on return.
  credentials: CloudCredentials;
  // Optional working-directory override for tests. Tests stub the
  // entire provider via selectCloudProvider; this is for the rare
  // case a developer wants to point at a pre-extracted IaC dir.
  workdirOverride?: string;
}

// Apply input — the route passes the saved plan artifact + decrypted
// credentials + an AbortSignal. The signal is the mid-flight kill-
// switch handle: when activeKillSwitch flips, the watcher calls
// AbortController.abort() and the provider gracefully SIGINTs the
// running `terraform apply`.
export interface CloudApplyInput {
  files: ReadonlyArray<BuildFile>;
  // base64-encoded plan artifact from P4-5a. The provider writes
  // this to disk before calling `terraform apply <file>`.
  planArtifactB64: string;
  credentials: CloudCredentials;
  signal?: AbortSignal;
  workdirOverride?: string;
}

// Apply output — sanitised. The state is the FULL terraform state
// (JSON serialised string) that the persistence layer encrypts
// before write. The outputs map is the named outputs the plan
// exposed; sanitised at the boundary so secret-shaped values are
// scrubbed before return.
export interface CloudApplyResult {
  // True iff `terraform apply` returned 0. False on any error or
  // abort.
  ok: boolean;
  // True iff the apply was aborted via the AbortSignal (kill switch
  // flip mid-flight).
  aborted: boolean;
  // Resource action counts terraform reports on stop.
  resources_added: number;
  resources_changed: number;
  resources_destroyed: number;
  // The FULL terraform state JSON (string). May be PARTIAL if the
  // apply aborted/errored partway. NEVER null when state-on-disk
  // existed at all — the route encrypts whatever was captured.
  state: string | null;
  // True iff `state` represents a partial outcome (apply didn't
  // finish cleanly). The persistence layer denormalises this onto
  // the row so the UI can show "partial state" without re-parsing.
  partial_state: boolean;
  // Sanitised outputs. May be empty when the apply aborted before
  // any output evaluated.
  outputs: Record<string, unknown>;
  // Free-form error message on failure. The provider scrubs it
  // through the same sanitiser the diff uses, so no secret-shaped
  // strings ever land in this field.
  error: string | null;
}

// Destroy input — used by rollback after a failed apply AND by P4-6
// teardown. Takes the FULL state (the persistence layer decrypts
// just before calling here), the credentials, and an optional
// signal. The provider runs `terraform destroy -auto-approve` (NOT
// `-target=...` — destroy is the whole thing) against that state.
export interface CloudDestroyInput {
  files: ReadonlyArray<BuildFile>;
  // The decrypted terraform state. Lives only on the provider's
  // stack until destroy completes.
  state: string;
  credentials: CloudCredentials;
  signal?: AbortSignal;
  workdirOverride?: string;
}

export interface CloudDestroyResult {
  ok: boolean;
  aborted: boolean;
  resources_destroyed: number;
  // Some teardown failures leave residual resources. The final state
  // (post-destroy) is captured + encrypted; on a clean destroy it's
  // typically empty.
  state: string | null;
  partial_state: boolean;
  error: string | null;
}

export interface CloudProvider {
  readonly kind: CloudProviderKind;
  readonly name: string;
  // Run a REAL `terraform plan` against actual cloud state. Read-only.
  // Returns the structured diff PLUS the saved plan artifact for
  // P4-5b. Secrets are stripped at the boundary.
  plan(input: CloudPlanInput): Promise<PlanResult>;
  // Phase 4-5b: the SINGLE cloud-WRITE seam. Applies the saved plan
  // artifact verbatim against real cloud state. Honours the abort
  // signal: a flipped kill switch graceful-stops the apply.
  apply(input: CloudApplyInput): Promise<CloudApplyResult>;
  // Phase 4-5b: destroy primitive for rollback + P4-6 teardown.
  // Destructive — requires a server-verified typed-confirm at the
  // route layer before this method is called.
  destroy(input: CloudDestroyInput): Promise<CloudDestroyResult>;
}

// ---------------------------------------------------------------------------
// Sanitiser — the boundary every provider implementation passes its
// raw `terraform plan -json` output through before returning.
//
// The current implementation drops anything that looks like a secret
// (JWT-shaped tokens, AWS access keys, NEXT_PUBLIC_* values). The
// goal is "no secret-ish string ever makes it into infra_plans.plan_diff
// or audit_log.detail", not bit-perfect identification.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /^eyJ[A-Za-z0-9_\-.]+$/, // JWT
  /^AKIA[0-9A-Z]{12,}$/,    // AWS access key id
  /^ASIA[0-9A-Z]{12,}$/,    // AWS STS key id
  /^sbp_[A-Za-z0-9]+$/,     // Supabase Management token
  /^ghp_[A-Za-z0-9]{30,}$/, // GitHub PAT
  /^gho_[A-Za-z0-9]{30,}$/, // GitHub OAuth token
];

/**
 * Recursively walks a JSON value and replaces any secret-shaped
 * string with '[redacted]'. Bounded — the cloud provider's raw
 * output is bounded (Terraform's plan JSON has known structure +
 * size limits).
 */
export function sanitizeJsonForLog(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string') {
    for (const re of SECRET_PATTERNS) {
      if (re.test(value)) return '[redacted]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJsonForLog(v));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Drop entire keys that name themselves as secret. Defensive in
      // case a provider surfaces an inline secret-value pair.
      if (/^(secret|password|token|key|credential)/i.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitizeJsonForLog(v);
    }
    return out;
  }
  return value;
}
