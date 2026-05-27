// DbProvider abstraction — the single seam the software DB
// provisioning route reaches through. Two implementations:
//
//   - MANAGED — calls the Supabase Management API to create a fresh
//     Supabase project under the user's account, then returns the
//     new project's URL + anon key + service-role key. Requires a
//     'supabase' connection (PAT or OAuth token) stored encrypted
//     via lib/crypto.
//   - BYO     — the user supplies an existing Supabase project's
//     connection details (URL + anon + service-role). The provider
//     trusts the inputs and applies the migration to that project.
//
// Both implementations must `applyMigration()` the SAME generated
// RLS migration text — so the deployed DB is bit-identical to the
// schema the P3-4 isolation test already validated.
//
// SECURITY CONTRACT every implementation must uphold:
//
//   - The service-role key is the only secret on the
//     ProvisionedDb. It MUST be a server-only string; the route
//     layer encrypts it via lib/crypto.encryptSecret before any DB
//     row carries it, and NEVER returns the raw value in a response
//     payload.
//   - The anon key + URL are public (the URL is reachable from
//     every browser hitting the deployed app; the anon key is
//     bundled into the browser bundle). RLS in the database is the
//     only thing standing between an anon key and another user's
//     rows.
//   - applyMigration() runs the EXACT generated SQL from
//     build_files. No edits, no fixes, no LLM in this path. The
//     migration is the structural proof from P3-4 carried forward.

export type DbProviderKind = 'managed' | 'byo';

export interface ProvisionedDb {
  // Public reach: the URL the browser bundle posts to.
  supabaseUrl: string;
  // Public-ish: the anon key the browser bundle uses to call the
  // database. RLS scopes what it can do.
  anonKey: string;
  // SECRET. Server-only. The route layer encrypts this immediately
  // and drops it from any further response.
  serviceRoleKey: string;
  // For managed provisioning: the Supabase project ref returned by
  // the Management API. Null for BYO — we don't ask the user to
  // expose theirs and we don't try to derive it.
  providerProjectRef: string | null;
}

export interface MigrationResult {
  // The number of statements applied. The migration is one file with
  // N statements; either it all applied or the provider threw.
  statementsApplied: number;
  // True when the apply step itself produced no error. The route
  // checks this before persisting migration_applied=true on the
  // software_databases row.
  ok: boolean;
  // Surface a server-side message ONLY (no secrets). Null on success.
  error: string | null;
}

export interface ProvisionInput {
  // Managed-only — the Supabase Management API token the provider
  // calls the platform with. For BYO, this is unused.
  managementToken?: string;
  // BYO-only — the user-supplied connection. For managed, this is
  // unused.
  byo?: {
    supabaseUrl: string;
    anonKey: string;
    serviceRoleKey: string;
  };
  // Free-form metadata for audit + observability. Never persisted as
  // a code path.
  metadata?: Record<string, string>;
  // For managed: project name to create. Default: "forge-software-app".
  projectName?: string;
  // For managed: region slug. Default: provider-picked.
  region?: string;
}

export interface DbProvider {
  readonly name: string;
  readonly kind: DbProviderKind;
  provision(opts: ProvisionInput): Promise<ProvisionedDb>;
  applyMigration(db: ProvisionedDb, sql: string): Promise<MigrationResult>;
}

// Concrete implementations live in ./managed.ts and ./byo.ts. The
// route layer picks via selectDbProvider in ./select.ts.
export { ManagedDbProvider } from './managed';
export { ByoDbProvider } from './byo';
