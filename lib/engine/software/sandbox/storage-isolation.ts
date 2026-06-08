// Aurexis Forge — Phase 3 (Software) LIVE cross-user isolation probe.
//
// THE RUNTIME PROOF the hermetic pglite test STRUCTURALLY CANNOT give.
//
// The pglite cross-user isolation test (./isolation.ts) proves DB-row
// isolation: B cannot read/update/delete A's owner-scoped ROWS. But pglite
// is DB-only — it has no Supabase Storage (`storage.objects`,
// `storage.foldername`) and no real Auth (JWT `app_metadata`). So two
// boundaries are, per the master doc §13, provable ONLY against live
// services:
//
//   1. STORAGE isolation — B cannot DOWNLOAD A's actual file bytes. The
//      owner-scoped `0002_storage.sql` policies are vetted structurally,
//      but never execute in pglite.
//   2. ADMIN-ROLE isolation — the admin-read crossing is keyed on real JWT
//      `app_metadata.role`; the escalation-closed property (a user cannot
//      self-promote via user_metadata) is only fully real with live Auth.
//
// This module is the PURE CORE of the probe: the spec predicates (does the
// probe apply?) and the FAIL-CLOSED VERDICT functions. The live execution
// (real Supabase Auth + Storage) lives in ./storage-isolation-live.ts and
// is the ONLY caller of the supabase client — splitting keeps THIS module
// hermetically testable, so the guarantee "a leak reads as FAILED, an
// unprovable result reads as ERRORED (and both block deploy)" is a pure
// function a unit test pins. If the deny path ever starts allowing, the
// pure test goes red.
//
// FAIL-CLOSED is the whole posture: the ONLY outcome that lets a deploy
// through is a clean proof (positive control allowed + every cross-user
// read denied). A leak, a broken control, a setup error, or an ambiguous
// observation all BLOCK. Better to refuse a deploy than to ship a tenant
// data leak.

import type { SoftwareSpec } from '../spec';
import { fileUploadSlots } from '../codegen/file-upload';
import { adminViewableEntities } from '../codegen/admin-dashboard';

// ---------------------------------------------------------------------------
// Does the probe apply to this spec?
//
// Both boundaries only exist when the spec opts into the feature AND auth is
// on (owner-scoping needs auth.uid()). When a probe doesn't apply, it passes
// VACUOUSLY — honest, not a silent skip (mirrors the pglite test's vacuous
// pass when auth is off).
// ---------------------------------------------------------------------------

/** Storage probe applies iff the app has auth + at least one file-upload slot. */
export function storageProbeApplies(spec: SoftwareSpec): boolean {
  return spec.auth.requires_auth && fileUploadSlots(spec).length > 0;
}

/** Admin probe applies iff the app has auth + at least one admin-viewable entity. */
export function adminProbeApplies(spec: SoftwareSpec): boolean {
  return spec.auth.requires_auth && adminViewableEntities(spec).length > 0;
}

// ---------------------------------------------------------------------------
// Observation shapes — the raw facts the LIVE runner gathers. Each cross-user
// access collapses to one of three outcomes:
//   'allowed' — the principal GOT the protected data (bytes / a row). For a
//               cross-user read this is a LEAK.
//   'denied'  — the principal was cleanly refused (no bytes / zero rows, via
//               an auth/permission/not-found refusal). This is the wanted
//               state for a cross-user read, AND the wanted state's opposite
//               for the positive control.
//   'error'   — anything else (network, unexpected status, setup hiccup). An
//               error is NOT a proof of denial — it is treated as unprovable
//               and FAILS CLOSED.
// ---------------------------------------------------------------------------

export type ProbeReadOutcome = 'allowed' | 'denied' | 'error';

export interface StorageProbeObservation {
  // false => the probe didn't apply to this spec (vacuous pass).
  readonly ran: boolean;
  // Non-null => setup (user creation, sign-in, planting the object) failed.
  // The probe could prove nothing → fail closed.
  readonly setupError: string | null;
  // POSITIVE CONTROL — A downloads A's OWN object. Must be 'allowed', else
  // the bucket/policy/migration is broken live and no denial can be trusted.
  readonly aReadOwn: ProbeReadOutcome;
  // NEGATIVE — B downloads A's object. Must be 'denied'. 'allowed' is the
  // headline storage leak.
  readonly bReadA: ProbeReadOutcome;
  // INVERSE NEGATIVE — A downloads a B-owned object. Must be 'denied'. Proves
  // the probe isn't trivially passing in one direction only.
  readonly aReadB: ProbeReadOutcome;
}

export interface AdminProbeObservation {
  readonly ran: boolean;
  readonly setupError: string | null;
  // NEGATIVE — a non-admin (no role) reads another owner's row. Must be
  // 'denied' (RLS scopes it out → zero rows).
  readonly nonAdminReadOther: ProbeReadOutcome;
  // ESCALATION-CLOSED — a user with user_metadata.role='admin' (the
  // user-editable claim) reads another owner's row. Must be 'denied': the
  // policy reads app_metadata ONLY, so user_metadata must NOT promote.
  readonly spoofedReadOther: ProbeReadOutcome;
  // POSITIVE CONTROL — a real admin (app_metadata.role='admin') reads another
  // owner's row. Must be 'allowed', else the admin path is broken and the
  // denials above prove nothing.
  readonly adminReadOther: ProbeReadOutcome;
}

// ---------------------------------------------------------------------------
// Verdict shapes.
// ---------------------------------------------------------------------------

export type ProbeOutcome = 'passed' | 'failed' | 'errored';

export interface StorageProbeResult {
  readonly probe: 'storage';
  readonly outcome: ProbeOutcome;
  // True when the probe didn't apply (folded into 'passed').
  readonly vacuous: boolean;
  // Human-facing one-liner. Null only on a non-vacuous clean pass.
  readonly reason: string | null;
  // Populated ONLY on a real leak ('failed') — which direction leaked.
  readonly leak: { direction: 'b_read_a' | 'a_read_b' } | null;
}

export interface AdminProbeResult {
  readonly probe: 'admin';
  readonly outcome: ProbeOutcome;
  readonly vacuous: boolean;
  readonly reason: string | null;
  // Populated ONLY on a real leak ('failed').
  readonly leak: { direction: 'non_admin_read' | 'user_metadata_escalation' } | null;
}

export interface PreDeployIsolationResult {
  // 'passed' iff BOTH sub-probes passed (or were vacuous). 'failed' if either
  // is a real leak (failed dominates errored). 'errored' if either couldn't
  // prove isolation and neither leaked.
  readonly outcome: ProbeOutcome;
  // True unless outcome === 'passed'. The deploy route blocks on this.
  readonly blocking: boolean;
  readonly storage: StorageProbeResult;
  readonly admin: AdminProbeResult;
  // Stable one-line summary for the audit log + the deploy response.
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// PURE VERDICTS — fail-closed. These NEVER touch the network; the live runner
// gathers observations, these decide. The ordering is deliberate:
//   1. vacuous (didn't apply)      -> passed
//   2. setup error                 -> errored (couldn't prove anything)
//   3. a cross-user read ALLOWED   -> failed  (report the LEAK first, so it is
//                                     never masked by a later 'error' branch)
//   4. positive control not allowed-> errored (proof is untrustworthy)
//   5. any required deny not clean -> errored (ambiguous == unprovable)
//   6. otherwise                   -> passed
// ---------------------------------------------------------------------------

export function evaluateStorageProbe(
  obs: StorageProbeObservation,
): StorageProbeResult {
  if (!obs.ran) {
    return {
      probe: 'storage',
      outcome: 'passed',
      vacuous: true,
      reason: 'no file-upload slots — no storage bucket to isolate',
      leak: null,
    };
  }
  if (obs.setupError) {
    return {
      probe: 'storage',
      outcome: 'errored',
      vacuous: false,
      reason: 'storage probe setup failed: ' + obs.setupError,
      leak: null,
    };
  }
  // LEAK first — an 'allowed' cross-user read is the headline failure.
  if (obs.bReadA === 'allowed') {
    return {
      probe: 'storage',
      outcome: 'failed',
      vacuous: false,
      reason: "STORAGE LEAK: user B downloaded user A's file (owner-scoped storage RLS not enforced live)",
      leak: { direction: 'b_read_a' },
    };
  }
  if (obs.aReadB === 'allowed') {
    return {
      probe: 'storage',
      outcome: 'failed',
      vacuous: false,
      reason: "STORAGE LEAK: user A downloaded user B's file (owner-scoped storage RLS not enforced live)",
      leak: { direction: 'a_read_b' },
    };
  }
  // Positive control — A must be able to read A's OWN file, else the proof is
  // worthless (a missing bucket / unapplied 0002 denies everything).
  if (obs.aReadOwn !== 'allowed') {
    return {
      probe: 'storage',
      outcome: 'errored',
      vacuous: false,
      reason:
        "storage probe positive control failed: user A could not read their OWN file (" +
        obs.aReadOwn +
        ') — the bucket or storage policy is likely not applied to the live project',
      leak: null,
    };
  }
  // Denies must be CLEAN refusals, not errors — an error is unprovable.
  if (obs.bReadA !== 'denied' || obs.aReadB !== 'denied') {
    return {
      probe: 'storage',
      outcome: 'errored',
      vacuous: false,
      reason:
        'storage probe could not cleanly observe denial (b_read_a=' +
        obs.bReadA +
        ', a_read_b=' +
        obs.aReadB +
        ') — treating as unprovable',
      leak: null,
    };
  }
  return {
    probe: 'storage',
    outcome: 'passed',
    vacuous: false,
    reason: null,
    leak: null,
  };
}

export function evaluateAdminProbe(
  obs: AdminProbeObservation,
): AdminProbeResult {
  if (!obs.ran) {
    return {
      probe: 'admin',
      outcome: 'passed',
      vacuous: true,
      reason: 'no admin-viewable entities — no admin-role crossing to isolate',
      leak: null,
    };
  }
  if (obs.setupError) {
    return {
      probe: 'admin',
      outcome: 'errored',
      vacuous: false,
      reason: 'admin probe setup failed: ' + obs.setupError,
      leak: null,
    };
  }
  if (obs.nonAdminReadOther === 'allowed') {
    return {
      probe: 'admin',
      outcome: 'failed',
      vacuous: false,
      reason: "ADMIN LEAK: a non-admin read another owner's row (admin-read RLS too permissive)",
      leak: { direction: 'non_admin_read' },
    };
  }
  if (obs.spoofedReadOther === 'allowed') {
    return {
      probe: 'admin',
      outcome: 'failed',
      vacuous: false,
      reason:
        "ADMIN LEAK: a user_metadata-spoofed 'admin' read another owner's row (privilege escalation — policy must read app_metadata only)",
      leak: { direction: 'user_metadata_escalation' },
    };
  }
  if (obs.adminReadOther !== 'allowed') {
    return {
      probe: 'admin',
      outcome: 'errored',
      vacuous: false,
      reason:
        'admin probe positive control failed: a real (app_metadata) admin could not read across owners (' +
        obs.adminReadOther +
        ') — the admin-read path is broken, so the denials prove nothing',
      leak: null,
    };
  }
  if (obs.nonAdminReadOther !== 'denied' || obs.spoofedReadOther !== 'denied') {
    return {
      probe: 'admin',
      outcome: 'errored',
      vacuous: false,
      reason:
        'admin probe could not cleanly observe denial (non_admin=' +
        obs.nonAdminReadOther +
        ', user_metadata_spoof=' +
        obs.spoofedReadOther +
        ') — treating as unprovable',
      leak: null,
    };
  }
  return {
    probe: 'admin',
    outcome: 'passed',
    vacuous: false,
    reason: null,
    leak: null,
  };
}

// ---------------------------------------------------------------------------
// Combine the two sub-probes into the single pre-deploy verdict. 'failed'
// dominates 'errored' dominates 'passed' — so a real leak is always the
// reported outcome, and the deploy blocks on anything that isn't a clean pass.
// ---------------------------------------------------------------------------

export function combineIsolationProbes(
  storage: StorageProbeResult,
  admin: AdminProbeResult,
): PreDeployIsolationResult {
  const anyFailed = storage.outcome === 'failed' || admin.outcome === 'failed';
  const anyErrored = storage.outcome === 'errored' || admin.outcome === 'errored';
  const outcome: ProbeOutcome = anyFailed
    ? 'failed'
    : anyErrored
      ? 'errored'
      : 'passed';

  const parts: string[] = [];
  parts.push('storage=' + describe(storage.outcome, storage.vacuous));
  parts.push('admin=' + describe(admin.outcome, admin.vacuous));
  const reasons = [storage.reason, admin.reason].filter(
    (r): r is string => Boolean(r) && r !== null,
  );
  let summary = 'pre-deploy isolation ' + outcome + ' (' + parts.join(', ') + ')';
  if (outcome !== 'passed' && reasons.length > 0) {
    summary += ' — ' + reasons.join('; ');
  }

  return {
    outcome,
    blocking: outcome !== 'passed',
    storage,
    admin,
    summary,
  };
}

function describe(outcome: ProbeOutcome, vacuous: boolean): string {
  if (outcome === 'passed' && vacuous) return 'passed(vacuous)';
  return outcome;
}
