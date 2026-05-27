// DB helpers for Phase 3-5a (software DB provisioning). Same shape
// as the other software persistence modules: loader → 409s every
// misroute, status-flip helpers, audit-log helpers.
//
// SECURITY hygiene enforced HERE — not by prompt-asking:
//
//   - persistSoftwareDatabase encrypts the service-role key with
//     lib/crypto.encryptSecret BEFORE the insert. The raw value is
//     dropped from the calling scope as soon as the row lands.
//   - loadSoftwareDatabase returns the encrypted blob + the last-4
//     display string; callers that need the raw key call
//     decryptServiceRole() which is the ONLY decryption seam.
//   - sanitizeDbForResponse() strips the encrypted blob so the
//     route layer can return the row body to the client safely.

import { decryptSecret, encryptSecret } from '@/lib/crypto';
import type { ForgeSupabase } from '@/lib/supabase';
import type {
  Build,
  BuildFile,
  Plan,
  Project,
  SoftwareDatabase,
  SoftwareDatabaseProviderKind,
  Spec,
} from '@/lib/types';
import { SoftwareSpecSchema, type SoftwareSpec } from '../spec';
import {
  SoftwareBuildPlanSchema,
  type SoftwareBuildPlan,
} from '../planner/schema';

export interface TestedSoftwareBuildContext {
  project: Project;
  build: Build;
  spec: SoftwareSpec;
  plan: SoftwareBuildPlan;
  // The generated migration text. The DbProvider applies this
  // VERBATIM — the structural proof from P3-4 carried forward.
  migrationSql: string;
}

const MIGRATION_FILE_PATH = 'supabase/migrations/0001_init.sql';

// Mirror of the Phase 1 + 2 + 3-4 loaders. Walks the
// (project → latest software build → spec → plan → files) chain
// and refuses any misroute with a clear 409. The build MUST be
// kind='software' AND status='tested' (P3-4 isolation passed).
export async function loadTestedSoftwareBuildForProvision(
  supabase: ForgeSupabase,
  projectId: string,
): Promise<TestedSoftwareBuildContext | { error: string; status: number }> {
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projErr || !project) return { error: 'project not found', status: 404 };

  const { data: builds } = await supabase
    .from('builds')
    .select('*')
    .eq('project_id', projectId)
    .eq('kind', 'software')
    .order('created_at', { ascending: false })
    .limit(1);
  const build = (builds?.[0] as Build | undefined) ?? null;
  if (!build) return { error: 'project has no software build', status: 409 };

  // Acceptable statuses: 'tested' (P3-4 passed) and
  // 'provision_failed' (user retrying after a previous failure).
  // NOT 'provisioned' — that would clobber an existing DB row.
  if (build.status !== 'tested' && build.status !== 'provision_failed') {
    return {
      error:
        "software build is in status '" +
        build.status +
        "'; only 'tested' (or 'provision_failed' for retry) can be provisioned",
      status: 409,
    };
  }
  if (!build.spec_id || !build.plan_id) {
    return { error: 'software build is missing spec_id or plan_id', status: 422 };
  }

  const { data: specRow } = await supabase
    .from('specs')
    .select('*')
    .eq('id', build.spec_id)
    .single();
  const spec = (specRow as Spec | null) ?? null;
  if (!spec) return { error: 'build references a missing spec', status: 422 };
  if (spec.kind !== 'software') {
    return {
      error:
        "build references a non-software spec (kind='" + spec.kind + "')",
      status: 409,
    };
  }
  const parsedSpec = SoftwareSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return {
      error: 'stored SoftwareSpec no longer matches the current schema',
      status: 422,
    };
  }

  const { data: planRow } = await supabase
    .from('plans')
    .select('*')
    .eq('id', build.plan_id)
    .single();
  const plan = (planRow as Plan | null) ?? null;
  if (!plan) return { error: 'build references a missing plan', status: 422 };
  if (plan.kind !== 'software') {
    return {
      error: "build references a non-software plan (kind='" + plan.kind + "')",
      status: 422,
    };
  }
  const parsedPlan = SoftwareBuildPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return {
      error: 'stored SoftwareBuildPlan no longer matches the current schema',
      status: 422,
    };
  }

  // Pull the migration text from build_files. The P3-3 codegen
  // always emits exactly this path; if it's missing, codegen
  // didn't finish cleanly and we 409 instead of provisioning a
  // half-built schema.
  const { data: files } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .eq('path', MIGRATION_FILE_PATH)
    .limit(1);
  const migrationFile = (files?.[0] as BuildFile | undefined) ?? null;
  if (!migrationFile) {
    return {
      error:
        "software build is missing its RLS migration at '" +
        MIGRATION_FILE_PATH +
        "'; re-run codegen",
      status: 422,
    };
  }

  return {
    project: project as Project,
    build,
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    migrationSql: migrationFile.content,
  };
}

// Refuse a re-provision when a software_databases row already
// exists for this build and migration_applied=true. The user can
// retry from 'provision_failed' or from a row with
// migration_applied=false; they can't clobber a working DB row by
// pressing Provision twice.
export async function checkSoftwareProvisionConcurrency(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const { data } = await supabase
    .from('software_databases')
    .select('id, migration_applied, created_at')
    .eq('build_id', buildId)
    .order('created_at', { ascending: false })
    .limit(1);
  const latest = data?.[0] as
    | { id: string; migration_applied: boolean; created_at: string }
    | undefined;
  if (!latest) return { ok: true };
  if (latest.migration_applied) {
    return {
      error:
        'this build already has a provisioned database (row ' +
        latest.id.slice(0, 8) +
        '); stop + re-tear-down to re-provision',
      status: 409,
    };
  }
  // Failed previous attempt — allow retry. The new row will land
  // alongside the old one; the route layer picks the latest via
  // loadLatestSoftwareDatabase.
  return { ok: true };
}

export async function markSoftwareBuildProvisioning(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'provisioning' })
    .eq('id', buildId);
}

export async function markSoftwareBuildProvisioned(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'provisioned' })
    .eq('id', buildId);
}

export async function markSoftwareBuildProvisionFailed(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<void> {
  await supabase
    .from('builds')
    .update({ status: 'provision_failed' })
    .eq('id', buildId);
}

// Persist a provisioned DB. Encrypts the service-role key BEFORE
// the insert; the caller MUST pass the raw key, and MUST drop the
// raw value from its scope after this call.
export interface PersistSoftwareDatabaseInput {
  projectId: string;
  buildId: string;
  providerKind: SoftwareDatabaseProviderKind;
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  providerProjectRef: string | null;
  migrationApplied: boolean;
}

export async function persistSoftwareDatabase(
  supabase: ForgeSupabase,
  input: PersistSoftwareDatabaseInput,
): Promise<SoftwareDatabase> {
  const enc = encryptSecret(input.serviceRoleKey);
  const last4 = input.serviceRoleKey.slice(-4);
  const { data, error } = await supabase
    .from('software_databases')
    .insert({
      project_id: input.projectId,
      build_id: input.buildId,
      provider_kind: input.providerKind,
      supabase_url: input.supabaseUrl,
      anon_key: input.anonKey,
      service_role_encrypted: enc,
      service_role_last4: last4,
      provider_project_ref: input.providerProjectRef,
      migration_applied: input.migrationApplied,
    })
    .select('*')
    .single();
  if (error || !data) {
    throw error ?? new Error('failed to insert software_databases row');
  }
  return data as SoftwareDatabase;
}

export async function loadLatestSoftwareDatabase(
  supabase: ForgeSupabase,
  buildId: string,
): Promise<SoftwareDatabase | null> {
  const { data, error } = await supabase
    .from('software_databases')
    .select('*')
    .eq('build_id', buildId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as SoftwareDatabase | null) ?? null;
}

// Strip the encrypted blob from a row before any response payload
// carries it. The encrypted blob isn't a usable secret without
// APP_ENC_KEY (server-only) but defence in depth says don't leak it
// to the client either.
export interface PublicSoftwareDatabase {
  id: string;
  project_id: string;
  build_id: string;
  provider_kind: string;
  supabase_url: string;
  anon_key: string;
  // Last 4 chars of the raw key for display, mirrors
  // connections.key_last4. The raw key is never returned.
  service_role_last4: string;
  provider_project_ref: string | null;
  migration_applied: boolean;
  created_at: string;
}

export function sanitizeDbForResponse(
  row: SoftwareDatabase,
): PublicSoftwareDatabase {
  return {
    id: row.id,
    project_id: row.project_id,
    build_id: row.build_id,
    provider_kind: row.provider_kind,
    supabase_url: row.supabase_url,
    anon_key: row.anon_key,
    service_role_last4: row.service_role_last4,
    provider_project_ref: row.provider_project_ref,
    migration_applied: row.migration_applied,
    created_at: row.created_at,
  };
}

// The ONLY decryption seam. Callers that need the raw service-role
// (deploy env injection, future admin-route slot) reach for this
// helper explicitly — it makes the secret-handling path easy to
// grep for in audits.
export function decryptServiceRole(row: SoftwareDatabase): string {
  return decryptSecret(row.service_role_encrypted);
}

// Audit-log helpers. NEVER pass the raw service-role key into the
// detail blob.

export async function logSoftwareDbAuthorized(
  supabase: ForgeSupabase,
  build: Build,
  providerKind: SoftwareDatabaseProviderKind,
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.db_authorized',
    actor: 'user',
    detail: { build_id: build.id, provider_kind: providerKind },
  });
}

export async function logSoftwareDbProvisioned(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    provider_kind: SoftwareDatabaseProviderKind;
    supabase_url: string;
    provider_project_ref: string | null;
    statements_applied: number;
    service_role_last4: string;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.db_provisioned',
    actor: 'engine.software.db',
    detail: { build_id: build.id, ...args },
  });
}

export async function logSoftwareDbFailed(
  supabase: ForgeSupabase,
  build: Build,
  args: {
    provider_kind: SoftwareDatabaseProviderKind;
    stage: 'provision' | 'apply_migration';
    message: string;
  },
): Promise<void> {
  await supabase.from('audit_log').insert({
    project_id: build.project_id,
    action: 'software.db_failed',
    actor: 'engine.software.db',
    detail: { build_id: build.id, ...args },
  });
}
