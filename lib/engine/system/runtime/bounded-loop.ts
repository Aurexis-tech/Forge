// BOUNDED-LOOP primitive — the safety-critical core of loop_with_break.
//
// A loop_with_break system re-invokes its body subgraph until a break
// condition OR a hard iteration cap. This helper owns the LOOP itself; it
// is pure (no DB, no LLM, no sandbox) and drives the loop through injected
// hooks so the whole boundedness + governance + cost story is provable in
// a hermetic test. It is the runtime analog of withRetry's `.retry.N`
// model (lib/engine/retry.ts): the caller re-runs governance per unit of
// work, and the helper guarantees the unit count can never run away.
//
// HARD INVARIANTS
//   - BOUNDED BY COUNT. The loop runs at most `maxIterations` times, and
//     maxIterations is itself clamped to [1, ENGINE_LOOP_CEILING]. Even a
//     malformed / hostile maxIterations cannot produce more than
//     ENGINE_LOOP_CEILING iterations — runaway is structurally impossible.
//   - BOUNDED BY COST. `killSwitchActive` + `assertAllowed` run BEFORE
//     each iteration's work. A kill switch flipped mid-loop halts the loop
//     after the current iteration (the next pre-iteration check trips);
//     an exhausted budget (GovernanceError from assertAllowed) halts
//     immediately. Neither is bypassable — there is no path to runIteration
//     that skips both gates.
//   - COST IS PAY-PER-USE. recordIterationCost fires ONCE per iteration
//     that ACTUALLY executed. An early break (or a mid-loop block) bills
//     only the k iterations that ran — never the full cap.
//
// The helper NEVER calls assertAllowed/recordCost/the executor directly —
// those are the caller's hooks (the scheduler binds the real, Supabase-
// bound implementations; tests bind spies). This keeps the dangerous
// surface (the loop) pure and the I/O at the edges.

import { GovernanceError } from '@/lib/engine/governance/guard';
import { ENGINE_LOOP_CEILING } from '../spec';
import { engineLog } from '@/lib/engine/log';

const log = engineLog('bounded-loop');

/** Why the loop stopped. */
export type LoopHaltReason =
  | 'break' // the controller decided to stop
  | 'max_iterations' // the hard cap was reached
  | 'kill_switch' // a kill switch fired (pre-iteration check or assertAllowed)
  | 'budget'; // the budget was exhausted (assertAllowed threw)

/** The controller's per-iteration verdict. */
export type LoopDecision = 'continue' | 'break';

export interface BoundedLoopIteration<TState> {
  /** Threaded state for the NEXT iteration (e.g. the body output). */
  readonly state: TState;
  /** The controller's decision for THIS iteration. */
  readonly decision: LoopDecision;
  /** Optional human-readable reason the controller broke. */
  readonly reason?: string;
}

export interface BoundedLoopHooks<TState> {
  /** Requested iteration cap. Clamped to [1, ENGINE_LOOP_CEILING]. */
  readonly maxIterations: number;
  /** Seed state handed to iteration 1. */
  readonly initialState: TState;
  /**
   * Pre-iteration kill-switch check. Returning true halts the loop BEFORE
   * the iteration runs (the kill flip halts after the current iteration).
   */
  readonly killSwitchActive: (iteration: number) => Promise<boolean>;
  /**
   * Pre-iteration governance gate. MUST throw GovernanceError when the
   * budget is exhausted / a kill switch is active. A throw halts the loop
   * before the iteration runs; that iteration is NOT billed.
   */
  readonly assertAllowed: (iteration: number) => Promise<void>;
  /** Execute ONE iteration (body subgraph + controller). */
  readonly runIteration: (
    iteration: number,
    state: TState,
  ) => Promise<BoundedLoopIteration<TState>>;
  /** Record the ledger event for an iteration that ACTUALLY executed. */
  readonly recordIterationCost: (
    iteration: number,
    state: TState,
  ) => Promise<void>;
}

export interface BoundedLoopResult<TState> {
  readonly haltedBy: LoopHaltReason;
  /** Iterations whose body actually executed (and were billed). */
  readonly iterationsRun: number;
  /** The clamped cap the loop actually ran under. */
  readonly cap: number;
  /** State after the last executed iteration (or the seed if none ran). */
  readonly finalState: TState;
  /** Controller break reason or governance block message, when applicable. */
  readonly reason?: string;
  /**
   * The GovernanceError that halted the loop, when haltedBy is 'budget' or
   * 'kill_switch' via assertAllowed. Lets the scheduler reuse the existing
   * budget-block handler (auto-pause) without reconstructing the error.
   */
  readonly governanceError?: GovernanceError;
}

/**
 * Run the bounded loop. Returns when the controller breaks, the cap is
 * hit, a kill switch fires, or the budget is exhausted — whichever comes
 * first. Never throws for governance blocks (those become a clean halt);
 * re-throws any non-governance error from a hook so genuine bugs surface.
 */
export async function runBoundedLoop<TState>(
  hooks: BoundedLoopHooks<TState>,
): Promise<BoundedLoopResult<TState>> {
  // Clamp the cap. `Math.floor(NaN) || 1` → 1; negatives/zero → 1;
  // anything above the ceiling → the ceiling. The loop can NEVER exceed
  // ENGINE_LOOP_CEILING regardless of what the caller passes.
  const requested = Math.floor(hooks.maxIterations);
  const cap = Math.min(
    Math.max(1, Number.isFinite(requested) ? requested : 1),
    ENGINE_LOOP_CEILING,
  );

  let state = hooks.initialState;
  let iterationsRun = 0;
  let reason: string | undefined;
  let haltedBy: LoopHaltReason = 'max_iterations';
  let governanceError: GovernanceError | undefined;

  for (let i = 1; i <= cap; i++) {
    // 1. Kill switch BEFORE doing any work this iteration.
    if (await hooks.killSwitchActive(i)) {
      haltedBy = 'kill_switch';
      reason = 'kill switch active before iteration ' + i;
      break;
    }

    // 2. Governance gate BEFORE doing any work this iteration. A
    //    GovernanceError becomes a clean halt (this iteration is NOT
    //    executed and NOT billed). Any other error is a real bug — rethrow.
    try {
      await hooks.assertAllowed(i);
    } catch (err) {
      if (err instanceof GovernanceError) {
        governanceError = err;
        haltedBy = err.reason === 'killed' ? 'kill_switch' : 'budget';
        reason = err.message;
        break;
      }
      throw err;
    }

    // 3. Execute the iteration (body subgraph + controller).
    const result = await hooks.runIteration(i, state);
    state = result.state;
    iterationsRun++;

    // 4. Bill ONLY iterations that actually executed.
    await hooks.recordIterationCost(i, state);

    // 5. Honour the controller's decision.
    if (result.decision === 'break') {
      haltedBy = 'break';
      reason = result.reason;
      break;
    }
    // else: continue. If i === cap, the loop exits with the default
    // haltedBy='max_iterations'.
  }

  log.info('loop halted', {
    haltedBy,
    iterationsRun,
    cap,
  });

  return { haltedBy, iterationsRun, cap, finalState: state, reason, governanceError };
}
