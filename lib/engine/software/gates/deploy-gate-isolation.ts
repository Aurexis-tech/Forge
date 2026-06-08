// Aurexis Forge — Capability Upgrade #4, gap 1: the ISOLATION DEPLOY GATE.
//
// An explicit, unit-testable choke-point that re-asserts cross-user isolation
// at the deploy moment — independent of the build-status state machine. The
// state machine already makes isolation build-failing (a leak → 'test_failed'
// → never 'pushed' → deploy never offered), and the live storage probe gates
// deploy too. THIS module is the third, deliberate lock: a pure function the
// deploy path can call so that {authorized:true} can NEVER reach a real deploy
// unless a FRESH, PASSING isolation result exists for the CURRENT build.
//
// FAIL-CLOSED by construction. The gate blocks on:
//   - isolation_missing — no isolation result recorded at all
//   - isolation_failed  — the recorded result is a leak
//   - isolation_stale   — the result passed, but for an EARLIER build (a later
//                         codegen could have introduced a leak the old pass
//                         never saw)
// and only yields 'awaiting_authorization' when the result PASSED for exactly
// this build. Non-multi-user molds (agent/system/infra) have no cross-user
// data surface and skip the isolation requirement.

export type Mold = 'software' | 'agent' | 'system' | 'infrastructure';

// The molds with a real multi-user data surface to isolate. Only 'software'
// today; kept as a set so a future multi-tenant mold opts in explicitly.
const MULTI_USER_MOLDS: ReadonlySet<string> = new Set<string>(['software']);

export interface IsolationRecord {
  // 'pass' iff the cross-user isolation proof passed (no read/write leak).
  readonly status: 'pass' | 'fail';
  // When the proof ran (ISO string / opaque marker). Carried for the audit
  // trail; the gate keys staleness on buildHash, not time.
  readonly checkedAt: string;
  // The build the proof was run against. Staleness = this != run.buildHash.
  readonly buildHash: string;
}

export interface RunState {
  readonly id: string;
  readonly mold: Mold | string;
  // Identifies the current generated artifact. A new codegen → new hash, so a
  // prior isolation pass no longer counts.
  readonly buildHash: string;
  // Recorded checks. recordIsolation() writes `isolation` here.
  checks: { isolation?: IsolationRecord };
}

export type BlockReason =
  | 'isolation_missing'
  | 'isolation_failed'
  | 'isolation_stale';

export type GateDecision =
  | { readonly state: 'blocked'; readonly reason: BlockReason }
  | { readonly state: 'awaiting_authorization' };

// Thrown by assertDeployable / applyDeploy. Carries the machine-readable
// reason so a route can map it to a status + surface it.
export class DeployBlocked extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? 'deploy blocked: ' + reason);
    this.name = 'DeployBlocked';
    this.reason = reason;
  }
}

// Record (or overwrite) the isolation result on a run. Mutates `run` and
// returns it for convenience.
export function recordIsolation(run: RunState, record: IsolationRecord): RunState {
  run.checks = { ...run.checks, isolation: record };
  return run;
}

// The pure gate decision. Never throws — callers decide what a 'blocked'
// decision means.
export function evaluateDeployGate(run: RunState): GateDecision {
  // Molds without a multi-user surface have no cross-user isolation to prove.
  if (!MULTI_USER_MOLDS.has(run.mold)) {
    return { state: 'awaiting_authorization' };
  }
  const iso = run.checks.isolation;
  if (!iso) return { state: 'blocked', reason: 'isolation_missing' };
  if (iso.status === 'fail') return { state: 'blocked', reason: 'isolation_failed' };
  if (iso.buildHash !== run.buildHash) {
    return { state: 'blocked', reason: 'isolation_stale' };
  }
  // Passed AND fresh — the only path that opens the gate (still needs the
  // explicit authorization step downstream).
  return { state: 'awaiting_authorization' };
}

// Throw unless the run is deployable. The hard assertion the deploy path calls
// before acting.
export function assertDeployable(run: RunState): void {
  const decision = evaluateDeployGate(run);
  if (decision.state === 'blocked') {
    throw new DeployBlocked(decision.reason);
  }
}

// The deploy choke-point. RE-ASSERTS deployability so an {authorized:true}
// flag can never bypass a missing/failed/stale isolation proof, THEN requires
// explicit authorization, THEN performs the deploy. Anything else throws
// DeployBlocked and the side-effecting `doDeploy` never runs.
export async function applyDeploy(
  run: RunState,
  authorized: boolean,
  doDeploy: () => Promise<void>,
): Promise<void> {
  // 1. Isolation re-assert — independent of any caller-supplied flag.
  assertDeployable(run);
  // 2. Explicit authorization — the gate is necessary but not sufficient.
  if (!authorized) {
    throw new DeployBlocked('not_authorized');
  }
  // 3. Only now does the real, side-effecting deploy run.
  await doDeploy();
}
