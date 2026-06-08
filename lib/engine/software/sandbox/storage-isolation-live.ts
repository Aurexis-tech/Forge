// Aurexis Forge — Phase 3 (Software) LIVE cross-user isolation probe (runner).
//
// The §13 RUNTIME PROOF: this is the ONLY module that exercises real Supabase
// Auth + Storage. It runs as a PRE-DEPLOY check against the provisioned
// project, gathers observations, and hands them to the PURE fail-closed
// verdicts in ./storage-isolation. The deploy route blocks on a non-passing
// result. Keeping the live calls here (and the verdict pure there) is what
// lets the guarantee be hermetically tested.
//
// It NEVER throws — every failure path collapses to a setupError observation,
// which the pure verdict turns into 'errored' (blocking). Fail-closed: an
// unprovable probe blocks the deploy exactly like a proven leak.
//
// SIDE EFFECTS (on the user's OWN provisioned project, all cleaned up
// best-effort): it creates a few ephemeral auth users, plants a tiny probe
// object / row owned by one of them, and reads it back as another. The reads
// run under real RLS (user-scoped JWT via the anon key) — service-role is used
// ONLY to set up + tear down, never to perform the cross-user read under test.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { SoftwareSpec } from '../spec';
import { STORAGE_BUCKET_ID } from '../codegen/file-upload';
import { adminViewableEntities } from '../codegen/admin-dashboard';
import { tableName } from '../codegen/migration';
import {
  adminProbeApplies,
  combineIsolationProbes,
  evaluateAdminProbe,
  evaluateStorageProbe,
  storageProbeApplies,
  type AdminProbeObservation,
  type PreDeployIsolationResult,
  type ProbeReadOutcome,
  type StorageProbeObservation,
} from './storage-isolation';

const PROBE_PREFIX = '__forge_probe__';
const PROBE_BYTES = 'aurexis-forge-cross-user-isolation-probe';
// Hard wall-clock cap per sub-probe so a hung Supabase call can't stall a
// deploy indefinitely. A timeout collapses to errored (fail-closed).
const SUB_PROBE_TIMEOUT_MS = 45_000;

export interface ProbeInput {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly spec: SoftwareSpec;
}

// ---------------------------------------------------------------------------
// Entry point. Runs whichever sub-probes apply to the spec, combines them into
// one fail-closed verdict. Never throws.
// ---------------------------------------------------------------------------
export async function runPreDeployIsolationProbes(
  input: ProbeInput,
): Promise<PreDeployIsolationResult> {
  const storageObs = storageProbeApplies(input.spec)
    ? await guard(() => runStorageProbe(input), storageSetupFail)
    : ({ ran: false, setupError: null, aReadOwn: 'denied', bReadA: 'denied', aReadB: 'denied' } as StorageProbeObservation);

  const adminObs = adminProbeApplies(input.spec)
    ? await guard(() => runAdminProbe(input), adminSetupFail)
    : ({ ran: false, setupError: null, nonAdminReadOther: 'denied', spoofedReadOther: 'denied', adminReadOther: 'allowed' } as AdminProbeObservation);

  return combineIsolationProbes(
    evaluateStorageProbe(storageObs),
    evaluateAdminProbe(adminObs),
  );
}

// ---------------------------------------------------------------------------
// STORAGE sub-probe — B must not download A's file; A must read its own
// (positive control); A must not read B's (inverse).
// ---------------------------------------------------------------------------
async function runStorageProbe(input: ProbeInput): Promise<StorageProbeObservation> {
  const service = serviceClient(input);
  const bucket = STORAGE_BUCKET_ID;

  // --- Setup: two ephemeral users + a planted object under each owner-path.
  const a = await createProbeUser(service, input);
  const b = await createProbeUser(service, input);
  const cleanup: Array<() => Promise<void>> = [];
  cleanup.push(() => deleteProbeUser(service, a.id));
  cleanup.push(() => deleteProbeUser(service, b.id));

  const aPath = a.id + '/' + PROBE_PREFIX + '/' + randomUUID() + '.txt';
  const bPath = b.id + '/' + PROBE_PREFIX + '/' + randomUUID() + '.txt';
  const blob = new Blob([PROBE_BYTES], { type: 'text/plain' });
  const up1 = await service.storage.from(bucket).upload(aPath, blob, { contentType: 'text/plain', upsert: true });
  const up2 = await service.storage.from(bucket).upload(bPath, blob, { contentType: 'text/plain', upsert: true });
  cleanup.push(() => removeProbeObject(service, bucket, aPath));
  cleanup.push(() => removeProbeObject(service, bucket, bPath));

  if (up1.error || up2.error) {
    // Could not plant — the bucket likely doesn't exist on the live project
    // (0002_storage.sql not applied). Unprovable → fail-closed.
    await runCleanup(cleanup);
    const why = up1.error?.message ?? up2.error?.message ?? 'unknown';
    return storageSetupFail('could not plant probe object in bucket ' + bucket + ': ' + why);
  }

  // --- User-scoped clients (real JWTs via the anon key — RLS in force).
  const aClient = await signInScoped(input, a);
  const bClient = await signInScoped(input, b);

  // --- The three reads, all under RLS.
  const aReadOwn = await attemptDownload(aClient, bucket, aPath); // positive control
  const bReadA = await attemptDownload(bClient, bucket, aPath);   // the leak test
  const aReadB = await attemptDownload(aClient, bucket, bPath);   // inverse

  await runCleanup(cleanup);
  return { ran: true, setupError: null, aReadOwn, bReadA, aReadB };
}

// ---------------------------------------------------------------------------
// ADMIN sub-probe — a non-admin and a user_metadata-spoofed "admin" must NOT
// read another owner's row; a real (app_metadata) admin must (positive
// control). Generated entity columns are nullable, so a row plants with just
// owner_id — exactly like the pglite isolation driver.
// ---------------------------------------------------------------------------
async function runAdminProbe(input: ProbeInput): Promise<AdminProbeObservation> {
  const service = serviceClient(input);
  const entity = adminViewableEntities(input.spec)[0];
  if (!entity) return { ran: false, setupError: null, nonAdminReadOther: 'denied', spoofedReadOther: 'denied', adminReadOther: 'allowed' };
  const table = tableName(entity);

  // owner A (holds the row), non-admin B, real admin C (app_metadata),
  // spoofed admin D (user_metadata — must NOT be promoted).
  const a = await createProbeUser(service, input);
  const b = await createProbeUser(service, input);
  const c = await createProbeUser(service, input, { app_metadata: { role: 'admin' } });
  const d = await createProbeUser(service, input, { user_metadata: { role: 'admin' } });
  const cleanup: Array<() => Promise<void>> = [
    () => deleteProbeUser(service, a.id),
    () => deleteProbeUser(service, b.id),
    () => deleteProbeUser(service, c.id),
    () => deleteProbeUser(service, d.id),
  ];

  // Plant one row owned by A (service-role bypasses RLS for setup).
  const ins = await service.from(table).insert({ owner_id: a.id }).select('id').single();
  if (ins.error || !ins.data) {
    await runCleanup(cleanup);
    return adminSetupFail('could not plant admin probe row in ' + table + ': ' + (ins.error?.message ?? 'no row'));
  }
  const rowId = (ins.data as { id: string }).id;
  cleanup.push(() => removeProbeRow(service, table, rowId));

  const bClient = await signInScoped(input, b);
  const cClient = await signInScoped(input, c);
  const dClient = await signInScoped(input, d);

  const nonAdminReadOther = await attemptRowRead(bClient, table, a.id); // must be denied
  const spoofedReadOther = await attemptRowRead(dClient, table, a.id);  // must be denied (escalation closed)
  const adminReadOther = await attemptRowRead(cClient, table, a.id);    // must be allowed (control)

  await runCleanup(cleanup);
  return { ran: true, setupError: null, nonAdminReadOther, spoofedReadOther, adminReadOther };
}

// ---------------------------------------------------------------------------
// Read attempts → ProbeReadOutcome.
// ---------------------------------------------------------------------------

// Storage: got the bytes => allowed (a LEAK for a cross-user read). A storage
// error (RLS hides the object) => denied. A thrown exception => error.
async function attemptDownload(
  client: SupabaseClient,
  bucket: string,
  path: string,
): Promise<ProbeReadOutcome> {
  try {
    const { data, error } = await client.storage.from(bucket).download(path);
    if (data) return 'allowed';
    if (error) return 'denied';
    return 'denied';
  } catch {
    return 'error';
  }
}

// Row: RLS denial is a clean EMPTY result set (not an error). Seeing the row
// => allowed. Empty => denied. A query error => error (unexpected).
async function attemptRowRead(
  client: SupabaseClient,
  table: string,
  ownerId: string,
): Promise<ProbeReadOutcome> {
  try {
    const { data, error } = await client.from(table).select('id').eq('owner_id', ownerId).limit(1);
    if (error) return 'error';
    return Array.isArray(data) && data.length > 0 ? 'allowed' : 'denied';
  } catch {
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// Supabase client + ephemeral-user helpers.
// ---------------------------------------------------------------------------

function serviceClient(input: ProbeInput): SupabaseClient {
  return createClient(input.supabaseUrl, input.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface ProbeUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

async function createProbeUser(
  service: SupabaseClient,
  input: ProbeInput,
  meta?: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> },
): Promise<ProbeUser> {
  const email = 'forge-isolation-probe-' + randomUUID() + '@example.com';
  const password = randomUUID() + randomUUID().toUpperCase() + '1!';
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: meta?.app_metadata,
    user_metadata: meta?.user_metadata,
  });
  if (error || !data?.user) {
    throw new Error('createUser failed: ' + (error?.message ?? 'no user returned'));
  }
  return { id: data.user.id, email, password };
}

// Sign in with the anon key to get a REAL user JWT, then bind it so every
// request from this client runs under that user's RLS.
async function signInScoped(input: ProbeInput, user: ProbeUser): Promise<SupabaseClient> {
  const anon = createClient(input.supabaseUrl, input.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  const token = data?.session?.access_token;
  if (error || !token) {
    throw new Error('signIn failed for probe user: ' + (error?.message ?? 'no session'));
  }
  return createClient(input.supabaseUrl, input.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: 'Bearer ' + token } },
  });
}

// ---------------------------------------------------------------------------
// Cleanup + guards.
// ---------------------------------------------------------------------------

async function deleteProbeUser(service: SupabaseClient, id: string): Promise<void> {
  try {
    await service.auth.admin.deleteUser(id);
  } catch {
    /* best-effort */
  }
}

async function removeProbeObject(service: SupabaseClient, bucket: string, path: string): Promise<void> {
  try {
    await service.storage.from(bucket).remove([path]);
  } catch {
    /* best-effort */
  }
}

async function removeProbeRow(service: SupabaseClient, table: string, id: string): Promise<void> {
  try {
    await service.from(table).delete().eq('id', id);
  } catch {
    /* best-effort */
  }
}

async function runCleanup(steps: Array<() => Promise<void>>): Promise<void> {
  for (const step of steps) {
    await step();
  }
}

// Run an async producer with a hard timeout; on throw OR timeout, fall back to
// the matching setup-failure observation (→ errored → blocking). Never throws.
async function guard<T>(
  produce: () => Promise<T>,
  onFail: (message: string) => T,
): Promise<T> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('probe timed out after ' + SUB_PROBE_TIMEOUT_MS + 'ms')), SUB_PROBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([produce(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    return onFail(err instanceof Error ? err.message : String(err));
  }
}

function storageSetupFail(message: string): StorageProbeObservation {
  return { ran: true, setupError: message, aReadOwn: 'error', bReadA: 'error', aReadB: 'error' };
}

function adminSetupFail(message: string): AdminProbeObservation {
  return { ran: true, setupError: message, nonAdminReadOther: 'error', spoofedReadOther: 'error', adminReadOther: 'error' };
}
