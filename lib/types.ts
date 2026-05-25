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

export type ConnectionProvider = 'github' | 'vercel' | 'anthropic' | 'e2b';
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
