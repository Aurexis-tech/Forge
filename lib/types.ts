// Database row types — mirror supabase/migrations/0001_init.sql.
// Hand-maintained for now; once Supabase CLI is wired up you can replace
// this with `supabase gen types typescript`.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ProjectStatus = 'draft' | 'planning' | 'building' | 'ready' | 'failed';

// Project-kind discriminator, persisted on both `projects` and `specs`
// rows. Tells the engine which Zod schema applies to
// `specs.structured_spec` and which downstream paths are gated.
//   - 'agent'          — Phase 1: single-agent AgentSpec, full build pipeline.
//   - 'system'         — Phase 2: multi-agent SystemSpec, intake + planning.
//   - 'software'       — Phase 3: SoftwareSpec, intake-only.
//   - 'infrastructure' — Phase 4: InfraSpec, intake-only (review-only this phase).
// Defaults to 'agent' for every row that predates Phase 2/3/4.
export type ProjectKind = 'agent' | 'system' | 'software' | 'infrastructure';

export interface Project {
  id: string;
  user_id: string | null;
  name: string;
  status: ProjectStatus | string;
  kind: ProjectKind | string;
  created_at: string;
}

export type SpecStatus =
  | 'pending'
  | 'extracting'
  | 'needs_clarification'
  | 'awaiting_review'
  | 'confirmed'
  | 'failed';

export interface SpecFeedbackAnswer {
  question: string;
  answer: string;
}

export interface SpecFeedback {
  answers?: SpecFeedbackAnswer[];
  refinements?: string[];
}

export interface Spec {
  id: string;
  project_id: string;
  raw_prompt: string;
  structured_spec: Json | null;
  open_questions: string[] | null;
  feedback: SpecFeedback | null;
  status: SpecStatus | string;
  // Phase 2: discriminator for which schema applies to structured_spec.
  // Defaults to 'agent' for every row created before Phase 2.
  kind: ProjectKind | string;
  created_at: string;
  // Spec-fidelity leg: optional per-top-level-field confidence map
  // (stated | inferred | guessed | missing). Added by migration 0028.
  // Existing reads ignore it; the show-spec gate UI consumes it via
  // components/spec/confidence-display.ts. Null for historical rows.
  confidence_json?: Json | null;
}

export type PlanStatus =
  | 'pending'
  | 'planning'
  | 'awaiting_review'
  | 'approved'
  | 'failed';

export interface PlanFeedback {
  refinements?: string[];
}

export interface Plan {
  id: string;
  project_id: string;
  spec_id: string;
  plan: Json | null;
  status: PlanStatus | string;
  feedback: PlanFeedback | null;
  // Phase 2: discriminator for which schema applies to `plan` —
  // 'agent' = BuildPlan (Phase 1), 'system' = OrchestrationPlan.
  // Defaults to 'agent' for every row created before Phase 2.
  kind: ProjectKind | string;
  created_at: string;
}

export type BuildStatus =
  | 'queued'
  | 'generating'
  | 'generated'
  | 'testing'
  | 'tested'
  | 'test_failed'
  // Phase 3-5a: software DB provisioning lifecycle. Lives between
  // 'tested' and (the still-locked) 'pushing' for kind='software'.
  // The agent/system molds do not transit these states.
  | 'provisioning'
  | 'provisioned'
  | 'provision_failed'
  // Phase 4-4: infra preview lifecycle. Lives between 'generated'
  // and (the still-locked) provision step for kind='infrastructure'.
  // 'preview_blocked' = over-budget ceiling verdict; provisioning
  // stays closed until the cap is raised or the spec trimmed.
  | 'previewing'
  | 'previewed'
  | 'preview_blocked'
  // Phase 4-5a: real-cloud `terraform plan` lifecycle. The first real
  // cloud contact. 'planning' = read-only plan in flight; 'plan_confirmed'
  // = ready-to-apply (apply is P4-5b — still NOT a write to cloud);
  // 'plan_blocked' = real-plan cost re-check over budget OR destructive
  // gate refused.
  | 'planning'
  | 'plan_confirmed'
  | 'plan_blocked'
  // Phase 4-5b: apply lifecycle. 'applying' = `terraform apply` in
  // flight against real cloud (the ONLY write); 'apply_failed' = apply
  // errored OR killswitched (partial state captured); 'destroying' =
  // gated destroy in flight; 'destroyed' = teardown complete.
  // 'provisioned' (already in the union from P3-5a) is the success
  // state for infrastructure too.
  | 'applying'
  | 'apply_failed'
  | 'destroying'
  | 'destroyed'
  | 'pushing'
  | 'pushed'
  | 'push_failed'
  | 'deploying'
  | 'deployed'
  | 'deploy_failed'
  | 'running'
  | 'success'
  | 'failed';

export interface BuildLogs {
  static_checks?: Array<{
    path: string;
    status: 'ok' | 'failed' | 'skipped';
    error?: string;
  }>;
  warnings?: string[];
  [key: string]: unknown;
}

export interface Build {
  id: string;
  project_id: string;
  spec_id: string | null;
  plan_id: string | null;
  phase: string | null;
  status: BuildStatus | string;
  logs: Json;
  repo_url: string | null;
  deploy_url: string | null;
  // Phase 2: discriminator for which codegen path produced this build —
  // 'agent' (Phase 1 single-file agent project) or 'system' (Phase 2
  // orchestrator + per-module project). Defaults to 'agent' for every
  // row created before Phase 2.
  kind: ProjectKind | string;
  created_at: string;
  updated_at: string;
}

export type BuildFileSource = 'scaffold' | 'generated';

export interface BuildFile {
  id: string;
  build_id: string;
  path: string;
  content: string;
  source: BuildFileSource;
  bytes: number;
  created_at: string;
}

export type ConnectionProvider =
  | 'github'
  | 'vercel'
  | 'anthropic'
  | 'e2b'
  // Phase 3-5a: the Supabase Management API token, used by the
  // 'managed' DbProvider to create a fresh Supabase project on the
  // user's account. Same encryption + storage shape as the other
  // connection providers (token encrypted at rest via lib/crypto).
  | 'supabase'
  // Phase 4-5a: the cloud-provider credential bundle the CloudProvider
  // seam reads when running a REAL `terraform plan`. Encrypted at
  // rest like every other connection. NEVER returned in any response.
  | 'cloud';
export type ByokProvider = Extract<ConnectionProvider, 'anthropic' | 'e2b'>;
export type KeySource = 'platform' | 'byok';

export interface Deployment {
  id: string;
  build_id: string;
  provider: string;
  project_ref: string | null;
  deployment_id: string | null;
  url: string | null;
  status: string | null;
  env_keys: string[];
  created_at: string;
}

// Phase 3-5a: the software DB the Forge provisioned (or connected
// to) for a software build. The service_role_encrypted column holds
// the only secret — AES-256-GCM ciphertext, decrypted ONLY inside
// the server when applying the migration or generating a deploy env
// payload. NEVER returned in any API response.
export type SoftwareDatabaseProviderKind = 'managed' | 'byo';

export interface SoftwareDatabase {
  id: string;
  project_id: string;
  build_id: string;
  provider_kind: SoftwareDatabaseProviderKind | string;
  supabase_url: string;
  anon_key: string;
  service_role_encrypted: string;
  service_role_last4: string;
  provider_project_ref: string | null;
  migration_applied: boolean;
  created_at: string;
}

// Phase 4-4: a deterministic preview of what an approved infra build
// would create, plus the cost-ceiling verdict. INERT — no terraform
// plan, no cloud call, no credentials. The full preview JSON blob
// lives in the `preview` column; the aggregated cost + ceiling
// fields are denormalised for fast UI rendering.
export type InfraCeilingVerdict =
  | 'within_budget'
  | 'over_budget'
  | 'no_budget_set';

export interface InfraPreview {
  id: string;
  project_id: string;
  build_id: string;
  estimated_usd_per_month: number;
  estimated_usd_per_hour: number;
  ceiling_verdict: InfraCeilingVerdict | string;
  ceiling_period: 'monthly' | 'daily' | string | null;
  ceiling_limit_usd: number | null;
  ceiling_projected_usd: number | null;
  preview: Json;
  ceiling_message: string;
  created_at: string;
}

// Phase 4-5a: the real `terraform plan` diff (read-only). Stored once
// per gate attempt. NEVER carries raw cloud credentials or secret
// values — the CloudProvider sanitises the diff at the boundary.
export interface InfraPlan {
  id: string;
  project_id: string;
  build_id: string;
  plan_diff: Json;
  destructive: boolean;
  create_count: number;
  change_count: number;
  destroy_count: number;
  ceiling_verdict: InfraCeilingVerdict | string;
  ceiling_period: 'monthly' | 'daily' | string | null;
  ceiling_limit_usd: number | null;
  ceiling_projected_usd: number | null;
  ceiling_message: string;
  confirmed_by_user_id: string | null;
  typed_phrase_required: string | null;
  typed_phrase_verified: boolean;
  confirmed_at: string | null;
  // Phase 4-5b: the base64-encoded `terraform plan -out=...` binary
  // file. Server-only. The apply route reads this and pipes it back
  // into `terraform apply <file>` so what's applied is EXACTLY what
  // the user confirmed — no drift between confirm and apply.
  plan_artifact_b64: string | null;
  created_at: string;
}

// Phase 4-6: a single drift-check result. INERT — derived from a
// read-only `terraform plan` against the IaC + live cloud state.
// No raw secrets, no terraform stdout in here; the route sanitises
// before insert.
export type InfraDriftVerdict = 'in_sync' | 'drifted' | 'failed';

export interface InfraDriftCheck {
  id: string;
  project_id: string;
  build_id: string;
  apply_id: string;
  verdict: InfraDriftVerdict | string;
  create_count: number;
  change_count: number;
  destroy_count: number;
  diff_summary: Json | null;
  error_message: string | null;
  created_at: string;
}

// Phase 4-5b: the apply outcome. ONE row per apply attempt. The
// encrypted terraform state lives here and NEVER leaves the server.
export type InfraApplyStatus =
  | 'applying'
  | 'succeeded'
  | 'failed'
  | 'killswitched'
  | 'destroying'
  | 'destroyed';

export interface InfraApply {
  id: string;
  project_id: string;
  build_id: string;
  plan_id: string;
  status: InfraApplyStatus | string;
  killswitched: boolean;
  partial_state: boolean;
  resources_added: number;
  resources_changed: number;
  resources_destroyed: number;
  // ENCRYPTED — AES-256-GCM via lib/crypto. NEVER returned in any
  // response. The sanitiser at the persistence boundary strips this
  // before any client-bound payload.
  state_encrypted: string | null;
  state_present: boolean;
  outputs_sanitised: Json;
  billed_usd_per_month: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface Connection {
  id: string;
  user_id: string | null;
  provider: ConnectionProvider | string;
  account_login: string | null;
  token_encrypted: string;
  scopes: string | null;
  // Last 4 chars of the API key for display ("•••• abcd"). NEVER the full
  // key. Populated for BYOK providers (anthropic / e2b); null for OAuth
  // providers where the token isn't a user-facing API key.
  key_last4: string | null;
  created_at: string;
}

export type RuntimeMode = 'schedule' | 'always_on';
export type RuntimeStatus = 'active' | 'paused' | 'stopped' | 'errored';

export interface AgentRuntime {
  id: string;
  project_id: string;
  build_id: string;
  mode: RuntimeMode | string;
  schedule_cron: string;
  status: RuntimeStatus | string;
  next_run_at: string | null;
  last_run_at: string | null;
  run_count: number;
  fail_count: number;
  consecutive_fails: number;
  max_run_ms: number;
  env_encrypted: string | null;
  env_keys: string[];
  // Phase 2: discriminator for which runtime executor handles this row
  // — 'agent' (Phase 1 single-agent executor) or 'system' (Phase 2
  // orchestrator executor). Defaults to 'agent' for every row created
  // before Phase 2.
  kind: ProjectKind | string;
  created_at: string;
  updated_at: string;
}

export type AgentRunTrigger = 'tick' | 'manual';
export type AgentRunStatus = 'running' | 'succeeded' | 'failed';

export interface AgentRunLogLine {
  stream: string;
  message: string;
  at: string;
}

export interface AgentRun {
  id: string;
  runtime_id: string;
  trigger: AgentRunTrigger | string;
  status: AgentRunStatus | string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  logs: Json;
  output: Json | null;
  error: string | null;
  created_at: string;
}

export type SandboxRunStatus = 'running' | 'passed' | 'failed';

export type SandboxPhase = 'install' | 'build' | 'smoke';

export interface SandboxLogLine {
  phase: SandboxPhase | 'system';
  stream: 'stdout' | 'stderr' | 'system';
  message: string;
  at: string;
}

export interface SandboxRun {
  id: string;
  build_id: string;
  provider: string;
  status: SandboxRunStatus | string;
  build_ok: boolean | null;
  smoke_ok: boolean | null;
  logs: Json;
  error: string | null;
  duration_ms: number | null;
  iterations: number;
  created_at: string;
}

export interface AuditLog {
  id: string;
  project_id: string | null;
  action: string;
  actor: string;
  detail: Json;
  created_at: string;
}

export type CostEventKind = 'llm' | 'sandbox' | 'runtime';

export interface CostEvent {
  id: string;
  user_id: string | null;
  project_id: string | null;
  kind: CostEventKind | string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  // Prompt-cache accounting (Anthropic). input_tokens is the uncached
  // (post-breakpoint) count; these capture cache writes + reads so the
  // dashboard can show a real cache hit-rate + savings. Default 0.
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  compute_ms: number;
  amount_usd: number;
  // 'platform' = the Forge's own key was used (we owe the provider);
  // 'byok'     = the user's connected key was used (informational only).
  key_source: KeySource | string;
  ref: string | null;
  created_at: string;
}

export type BudgetPeriod = 'daily' | 'monthly';

export interface Budget {
  id: string;
  user_id: string;
  period: BudgetPeriod | string;
  // CANONICAL enforced value. The guard compares spend-in-USD to this.
  limit_usd: number;
  hard_cap: boolean;
  // The currency the user typed the cap in — purely for display + future
  // re-render of the input. Enforcement still happens against limit_usd.
  display_currency: string;
  created_at: string;
}

export type KillSwitchScope = 'global' | 'user' | 'project';

export interface KillSwitch {
  id: string;
  scope: KillSwitchScope | string;
  scope_id: string | null;
  active: boolean;
  reason: string | null;
  set_by: string | null;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      projects: {
        Row: Project;
        Insert: Omit<Project, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Project>;
        Relationships: [];
      };
      specs: {
        Row: Spec;
        Insert: Omit<Spec, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Spec>;
        Relationships: [];
      };
      builds: {
        Row: Build;
        Insert: Omit<Build, 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Build>;
        Relationships: [];
      };
      audit_log: {
        Row: AuditLog;
        Insert: Omit<AuditLog, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<AuditLog>;
        Relationships: [];
      };
      plans: {
        Row: Plan;
        Insert: Omit<Plan, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Plan>;
        Relationships: [];
      };
      build_files: {
        Row: BuildFile;
        Insert: Omit<BuildFile, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<BuildFile>;
        Relationships: [];
      };
      sandbox_runs: {
        Row: SandboxRun;
        Insert: Omit<SandboxRun, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<SandboxRun>;
        Relationships: [];
      };
      connections: {
        Row: Connection;
        Insert: Omit<Connection, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Connection>;
        Relationships: [];
      };
      deployments: {
        Row: Deployment;
        Insert: Omit<Deployment, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Deployment>;
        Relationships: [];
      };
      software_databases: {
        Row: SoftwareDatabase;
        Insert: Omit<SoftwareDatabase, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<SoftwareDatabase>;
        Relationships: [];
      };
      infra_previews: {
        Row: InfraPreview;
        Insert: Omit<InfraPreview, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<InfraPreview>;
        Relationships: [];
      };
      infra_plans: {
        Row: InfraPlan;
        Insert: Omit<InfraPlan, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<InfraPlan>;
        Relationships: [];
      };
      infra_applies: {
        Row: InfraApply;
        Insert: Omit<InfraApply, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<InfraApply>;
        Relationships: [];
      };
      infra_drift_checks: {
        Row: InfraDriftCheck;
        Insert: Omit<InfraDriftCheck, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<InfraDriftCheck>;
        Relationships: [];
      };
      agent_runtimes: {
        Row: AgentRuntime;
        Insert: Omit<AgentRuntime, 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<AgentRuntime>;
        Relationships: [];
      };
      runs: {
        Row: AgentRun;
        Insert: Omit<AgentRun, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<AgentRun>;
        Relationships: [];
      };
      cost_events: {
        Row: CostEvent;
        Insert: Omit<CostEvent, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<CostEvent>;
        Relationships: [];
      };
      budgets: {
        Row: Budget;
        Insert: Omit<Budget, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Budget>;
        Relationships: [];
      };
      kill_switches: {
        Row: KillSwitch;
        Insert: Omit<KillSwitch, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<KillSwitch>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
