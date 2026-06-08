// LIVE cross-user isolation probe — PURE VERDICT core.
//
// Hermetic, no network. This is the test that goes RED if the deny path
// ever starts allowing: the live probe (storage-isolation-live.ts) gathers
// observations against real Supabase, but the FAIL-CLOSED decision is a pure
// function pinned here. The security guarantee under test:
//
//   - the ONLY observation that lets a deploy through is a clean proof
//     (positive control allowed + every cross-user read cleanly denied);
//   - a cross-user read that returns data is ALWAYS 'failed' (a leak), never
//     masked by a later branch and never 'passed';
//   - anything ambiguous (setup error, broken control, a deny that errored
//     instead of cleanly refusing) is 'errored' and BLOCKS the deploy.
//
// The predicates (does the probe apply?) are exercised against real specs so
// a spec that drops auth or the feature flips the probe to a vacuous pass —
// honest, not a silent skip.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  storageProbeApplies,
  adminProbeApplies,
  evaluateStorageProbe,
  evaluateAdminProbe,
  combineIsolationProbes,
  type ProbeReadOutcome,
  type StorageProbeObservation,
  type AdminProbeObservation,
} from '@/lib/engine/software/sandbox/storage-isolation';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';

const read = (p: string) => readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function spec(over: Partial<SoftwareSpec> = {}): SoftwareSpec {
  return SoftwareSpecSchema.parse({
    goal: 'A notes app.',
    pages: [{ id: 'dashboard', name: 'Dashboard', purpose: 'overview' }],
    entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
    flows: [],
    auth: { requires_auth: true, per_user_isolation: true },
    ...over,
  });
}

const OUTCOMES: ProbeReadOutcome[] = ['allowed', 'denied', 'error'];

function storageObs(
  over: Partial<StorageProbeObservation> = {},
): StorageProbeObservation {
  return {
    ran: true,
    setupError: null,
    aReadOwn: 'allowed',
    bReadA: 'denied',
    aReadB: 'denied',
    ...over,
  };
}

function adminObs(
  over: Partial<AdminProbeObservation> = {},
): AdminProbeObservation {
  return {
    ran: true,
    setupError: null,
    nonAdminReadOther: 'denied',
    spoofedReadOther: 'denied',
    adminReadOther: 'allowed',
    ...over,
  };
}

// ===========================================================================
// 1. Predicates — does the probe apply? (real specs)
// ===========================================================================
describe('storageProbeApplies', () => {
  it('true with auth + a file-upload slot', () => {
    expect(
      storageProbeApplies(
        spec({
          file_uploads: [
            { name: 'Attachment', max_size_mb: 5, content_types: ['image/png'] },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('false with no file-upload slots (vacuous — no bucket exists)', () => {
    expect(storageProbeApplies(spec())).toBe(false);
  });

  it('the spec schema itself forbids file_uploads with auth off — so a storage probe always has auth', () => {
    // The owner-scoped bucket keys on auth.uid(); a file-upload slot without
    // auth is incoherent and the schema refuses it. This is WHY the probe's
    // requires_auth guard is belt-and-braces, not the primary enforcer.
    expect(() =>
      spec({
        auth: { requires_auth: false, per_user_isolation: false },
        file_uploads: [
          { name: 'Attachment', max_size_mb: 5, content_types: ['image/png'] },
        ],
      }),
    ).toThrow();
  });
});

describe('adminProbeApplies', () => {
  it('true with auth + an admin-viewable entity', () => {
    expect(
      adminProbeApplies(
        spec({
          entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
          admin_dashboard: { entities: ['Note'] },
        }),
      ),
    ).toBe(true);
  });

  it('false with no admin dashboard', () => {
    expect(adminProbeApplies(spec())).toBe(false);
  });

  it('the spec schema itself forbids admin_dashboard with auth off — so an admin probe always has auth', () => {
    // The admin-read policy is additive on the owner policy; without auth +
    // per-user isolation there is no owner policy to cross. The schema refuses
    // the combination, making the probe's requires_auth guard belt-and-braces.
    expect(() =>
      spec({
        auth: { requires_auth: false, per_user_isolation: false },
        admin_dashboard: { entities: ['Note'] },
      }),
    ).toThrow();
  });
});

// ===========================================================================
// 2. evaluateStorageProbe — the fail-closed verdict
// ===========================================================================
describe('evaluateStorageProbe — named cases', () => {
  it('vacuous pass when the probe did not apply', () => {
    const r = evaluateStorageProbe(storageObs({ ran: false }));
    expect(r.outcome).toBe('passed');
    expect(r.vacuous).toBe(true);
    expect(r.leak).toBeNull();
  });

  it('PASSES only on a clean proof: control allowed + both cross-reads denied', () => {
    const r = evaluateStorageProbe(storageObs());
    expect(r.outcome).toBe('passed');
    expect(r.vacuous).toBe(false);
    expect(r.reason).toBeNull();
    expect(r.leak).toBeNull();
  });

  it('FAILS (leak b_read_a) when B downloaded A’s file', () => {
    const r = evaluateStorageProbe(storageObs({ bReadA: 'allowed' }));
    expect(r.outcome).toBe('failed');
    expect(r.leak).toEqual({ direction: 'b_read_a' });
    expect(r.reason).toMatch(/STORAGE LEAK/);
  });

  it('FAILS (leak a_read_b) when A downloaded B’s file (inverse not trivially passing)', () => {
    const r = evaluateStorageProbe(storageObs({ aReadB: 'allowed' }));
    expect(r.outcome).toBe('failed');
    expect(r.leak).toEqual({ direction: 'a_read_b' });
  });

  it('ERRORS (fail-closed) on setup failure', () => {
    const r = evaluateStorageProbe(
      storageObs({ setupError: 'could not create probe users' }),
    );
    expect(r.outcome).toBe('errored');
    expect(r.leak).toBeNull();
  });

  it('ERRORS when the positive control fails — A cannot read its OWN file (bucket/0002 likely unapplied)', () => {
    expect(evaluateStorageProbe(storageObs({ aReadOwn: 'denied' })).outcome).toBe('errored');
    expect(evaluateStorageProbe(storageObs({ aReadOwn: 'error' })).outcome).toBe('errored');
  });

  it('ERRORS when a required deny is not a CLEAN refusal (an error is unprovable)', () => {
    expect(evaluateStorageProbe(storageObs({ bReadA: 'error' })).outcome).toBe('errored');
    expect(evaluateStorageProbe(storageObs({ aReadB: 'error' })).outcome).toBe('errored');
  });
});

describe('evaluateStorageProbe — exhaustive invariants (3^3 observation space)', () => {
  const all: StorageProbeObservation[] = [];
  for (const aReadOwn of OUTCOMES)
    for (const bReadA of OUTCOMES)
      for (const aReadB of OUTCOMES)
        all.push(storageObs({ aReadOwn, bReadA, aReadB }));

  it('PASSES iff control allowed AND both cross-reads cleanly denied (the exact gate)', () => {
    for (const obs of all) {
      const passed = evaluateStorageProbe(obs).outcome === 'passed';
      const shouldPass =
        obs.aReadOwn === 'allowed' &&
        obs.bReadA === 'denied' &&
        obs.aReadB === 'denied';
      expect(passed).toBe(shouldPass);
    }
  });

  it('THE DENY GUARANTEE: any cross-user read that ALLOWS is always failed (never masked, never passed)', () => {
    for (const obs of all) {
      if (obs.bReadA === 'allowed' || obs.aReadB === 'allowed') {
        const r = evaluateStorageProbe(obs);
        expect(r.outcome).toBe('failed');
        expect(r.leak).not.toBeNull();
      }
    }
  });

  it('outcome is always one of passed/failed/errored and leak is set iff failed', () => {
    for (const obs of all) {
      const r = evaluateStorageProbe(obs);
      expect(['passed', 'failed', 'errored']).toContain(r.outcome);
      expect(r.leak !== null).toBe(r.outcome === 'failed');
    }
  });

  it('a setup error always errors, regardless of the (untrustworthy) read fields', () => {
    for (const obs of all) {
      expect(
        evaluateStorageProbe({ ...obs, setupError: 'boom' }).outcome,
      ).toBe('errored');
    }
  });
});

// ===========================================================================
// 3. evaluateAdminProbe — the sibling, same fail-closed discipline
// ===========================================================================
describe('evaluateAdminProbe — named cases', () => {
  it('vacuous pass when no admin crossing exists', () => {
    const r = evaluateAdminProbe(adminObs({ ran: false }));
    expect(r.outcome).toBe('passed');
    expect(r.vacuous).toBe(true);
  });

  it('PASSES only when admin reads across AND non-admin + spoofed are denied', () => {
    expect(evaluateAdminProbe(adminObs()).outcome).toBe('passed');
  });

  it('FAILS when a non-admin read another owner’s row', () => {
    const r = evaluateAdminProbe(adminObs({ nonAdminReadOther: 'allowed' }));
    expect(r.outcome).toBe('failed');
    expect(r.leak).toEqual({ direction: 'non_admin_read' });
  });

  it('FAILS on user_metadata escalation — a spoofed admin must NOT be promoted', () => {
    const r = evaluateAdminProbe(adminObs({ spoofedReadOther: 'allowed' }));
    expect(r.outcome).toBe('failed');
    expect(r.leak).toEqual({ direction: 'user_metadata_escalation' });
  });

  it('ERRORS when the positive control fails — a real admin cannot read across owners', () => {
    expect(evaluateAdminProbe(adminObs({ adminReadOther: 'denied' })).outcome).toBe('errored');
  });
});

describe('evaluateAdminProbe — exhaustive invariants', () => {
  const all: AdminProbeObservation[] = [];
  for (const adminReadOther of OUTCOMES)
    for (const nonAdminReadOther of OUTCOMES)
      for (const spoofedReadOther of OUTCOMES)
        all.push(adminObs({ adminReadOther, nonAdminReadOther, spoofedReadOther }));

  it('PASSES iff admin allowed AND non-admin + spoofed both cleanly denied', () => {
    for (const obs of all) {
      const passed = evaluateAdminProbe(obs).outcome === 'passed';
      const shouldPass =
        obs.adminReadOther === 'allowed' &&
        obs.nonAdminReadOther === 'denied' &&
        obs.spoofedReadOther === 'denied';
      expect(passed).toBe(shouldPass);
    }
  });

  it('THE DENY GUARANTEE: a non-admin OR user_metadata-spoofed read that allows is always failed', () => {
    for (const obs of all) {
      if (obs.nonAdminReadOther === 'allowed' || obs.spoofedReadOther === 'allowed') {
        expect(evaluateAdminProbe(obs).outcome).toBe('failed');
      }
    }
  });
});

// ===========================================================================
// 4. combineIsolationProbes — the single pre-deploy verdict
// ===========================================================================
describe('combineIsolationProbes', () => {
  const pass = evaluateStorageProbe(storageObs());
  const vac = evaluateStorageProbe(storageObs({ ran: false }));
  const leak = evaluateStorageProbe(storageObs({ bReadA: 'allowed' }));
  const errd = evaluateStorageProbe(storageObs({ setupError: 'x' }));
  const aPass = evaluateAdminProbe(adminObs());
  const aVac = evaluateAdminProbe(adminObs({ ran: false }));
  const aLeak = evaluateAdminProbe(adminObs({ nonAdminReadOther: 'allowed' }));
  const aErr = evaluateAdminProbe(adminObs({ adminReadOther: 'denied' }));

  it('passes (non-blocking) when both pass', () => {
    const r = combineIsolationProbes(pass, aPass);
    expect(r.outcome).toBe('passed');
    expect(r.blocking).toBe(false);
  });

  it('passes (non-blocking) when both are vacuous', () => {
    const r = combineIsolationProbes(vac, aVac);
    expect(r.outcome).toBe('passed');
    expect(r.blocking).toBe(false);
  });

  it('a storage leak blocks the deploy', () => {
    const r = combineIsolationProbes(leak, aPass);
    expect(r.outcome).toBe('failed');
    expect(r.blocking).toBe(true);
    expect(r.summary).toMatch(/STORAGE LEAK/);
  });

  it('an admin leak blocks the deploy', () => {
    const r = combineIsolationProbes(pass, aLeak);
    expect(r.outcome).toBe('failed');
    expect(r.blocking).toBe(true);
  });

  it('an errored probe blocks the deploy (fail-closed)', () => {
    const r = combineIsolationProbes(errd, aPass);
    expect(r.outcome).toBe('errored');
    expect(r.blocking).toBe(true);
  });

  it('failed dominates errored — a real leak is always the reported outcome', () => {
    const r = combineIsolationProbes(leak, aErr);
    expect(r.outcome).toBe('failed');
    expect(r.blocking).toBe(true);
  });

  it('summary always names both sub-probe outcomes', () => {
    const r = combineIsolationProbes(vac, aVac);
    expect(r.summary).toMatch(/storage=passed\(vacuous\)/);
    expect(r.summary).toMatch(/admin=passed\(vacuous\)/);
  });
});

// ===========================================================================
// 5. WIRING GUARDS — the probe is actually CALLED in the pre-deploy path,
// fail-closed, before the Vercel deploy; and provisioning applies the storage
// migration. These go red if someone unwires the probe or reverts the gap fix
// (a passing pure verdict is worthless if nothing runs it before deploy).
// ===========================================================================
describe('pre-deploy wiring', () => {
  const deployRoute = read(
    'app/api/projects/[id]/software/build/deploy/route.ts',
  );

  it('the deploy route runs the live probe and BLOCKS fail-closed before deploying to Vercel', () => {
    expect(deployRoute).toMatch(/runPreDeployIsolationProbes/);
    expect(deployRoute).toMatch(/isolation\.blocking/);
    // The probe call MUST precede the Vercel deploy call.
    const probeIdx = deployRoute.indexOf('runPreDeployIsolationProbes(');
    const deployIdx = deployRoute.indexOf('deployBuildToVercel(');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(probeIdx);
    // The result is surfaced on the response, not just logged.
    expect(deployRoute).toMatch(/surfaceIsolation/);
    expect(deployRoute).toMatch(/logSoftwareIsolationProbe/);
  });

  it('provisioning applies the storage migration (0002) so the live bucket + policies exist', () => {
    const persistence = read('lib/engine/software/db/persistence.ts');
    expect(persistence).toMatch(/STORAGE_MIGRATION_PATH/);
    expect(persistence).toMatch(/storageSql/);
  });

  it('the live runner uses service-role ONLY for setup — cross-user reads run under user JWT', () => {
    const live = read(
      'lib/engine/software/sandbox/storage-isolation-live.ts',
    );
    // The cross-user reads go through signed-in (anon-key + user JWT) clients.
    expect(live).toMatch(/signInWithPassword/);
    expect(live).toMatch(/Authorization.*Bearer/);
    // The bucket under test is the structural private bucket.
    expect(live).toMatch(/STORAGE_BUCKET_ID/);
  });
});
