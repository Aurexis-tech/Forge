// The SAFETY-CRITICAL CORE of loop_with_break. runBoundedLoop is a pure
// helper (no DB, no LLM, no sandbox) driven by injected hooks, so the
// whole boundedness + governance + cost story is provable here without
// any I/O. These tests are the proof that a bounded loop can NEVER run
// away:
//   - bounded by COUNT: at most maxIterations, clamped to ENGINE_LOOP_CEILING
//   - bounded by COST: killSwitch + assertAllowed gate EVERY iteration
//     before its work; a mid-loop block halts; cost is billed pay-per-use
//
// Mirrors the role lib/engine/retry.ts plays for retries.

import { describe, expect, it, vi } from 'vitest';
import {
  runBoundedLoop,
  type BoundedLoopHooks,
} from '@/lib/engine/system/runtime/bounded-loop';
import { GovernanceError } from '@/lib/engine/governance/guard';
import { ENGINE_LOOP_CEILING } from '@/lib/engine/system/spec';

// Build hooks with sane no-op defaults; tests override what they exercise.
// State is a running counter so we can also assert state threading.
function hooks(
  over: Partial<BoundedLoopHooks<number>> = {},
): BoundedLoopHooks<number> {
  return {
    maxIterations: 3,
    initialState: 0,
    killSwitchActive: async () => false,
    assertAllowed: async () => undefined,
    runIteration: async (_i, state) => ({ state: state + 1, decision: 'continue' }),
    recordIterationCost: async () => undefined,
    ...over,
  };
}

describe('runBoundedLoop — boundedness by COUNT', () => {
  it('a never-breaking loop runs EXACTLY maxIterations times', async () => {
    const run = vi.fn(async (_i: number, s: number) => ({
      state: s + 1,
      decision: 'continue' as const,
    }));
    const cost = vi.fn(async () => undefined);
    const res = await runBoundedLoop(
      hooks({ maxIterations: 3, runIteration: run, recordIterationCost: cost }),
    );
    expect(res.haltedBy).toBe('max_iterations');
    expect(res.iterationsRun).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
    expect(cost).toHaveBeenCalledTimes(3);
    expect(res.finalState).toBe(3); // state threaded across iterations
  });

  it('clamps a too-large maxIterations DOWN to ENGINE_LOOP_CEILING', async () => {
    const run = vi.fn(async (_i: number, s: number) => ({
      state: s + 1,
      decision: 'continue' as const,
    }));
    const res = await runBoundedLoop(
      hooks({ maxIterations: 9999, runIteration: run }),
    );
    expect(res.cap).toBe(ENGINE_LOOP_CEILING);
    expect(res.iterationsRun).toBe(ENGINE_LOOP_CEILING);
    expect(run).toHaveBeenCalledTimes(ENGINE_LOOP_CEILING);
  });

  it('clamps a non-positive / non-finite maxIterations UP to 1', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const run = vi.fn(async (_i: number, s: number) => ({
        state: s + 1,
        decision: 'continue' as const,
      }));
      const res = await runBoundedLoop(
        hooks({ maxIterations: bad, runIteration: run }),
      );
      expect(res.cap).toBe(1);
      expect(res.iterationsRun).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});

describe('runBoundedLoop — break', () => {
  it('a controller break after k iterations stops at EXACTLY k', async () => {
    const run = vi.fn(async (i: number, s: number) => ({
      state: s + 1,
      decision: (i === 2 ? 'break' : 'continue') as 'break' | 'continue',
      reason: i === 2 ? 'good enough' : undefined,
    }));
    const cost = vi.fn(async () => undefined);
    const res = await runBoundedLoop(
      hooks({ maxIterations: 5, runIteration: run, recordIterationCost: cost }),
    );
    expect(res.haltedBy).toBe('break');
    expect(res.reason).toBe('good enough');
    expect(res.iterationsRun).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    // COST: only the 2 iterations that ran are billed — never the full cap.
    expect(cost).toHaveBeenCalledTimes(2);
  });
});

describe('runBoundedLoop — per-iteration GOVERNANCE', () => {
  it('a kill switch flipped before iteration 3 halts with no 3rd body exec', async () => {
    // killSwitchActive returns true on the 3rd pre-iteration check.
    const kill = vi.fn(async (i: number) => i >= 3);
    const run = vi.fn(async (_i: number, s: number) => ({
      state: s + 1,
      decision: 'continue' as const,
    }));
    const cost = vi.fn(async () => undefined);
    const res = await runBoundedLoop(
      hooks({
        maxIterations: 5,
        killSwitchActive: kill,
        runIteration: run,
        recordIterationCost: cost,
      }),
    );
    expect(res.haltedBy).toBe('kill_switch');
    expect(res.iterationsRun).toBe(2);
    expect(run).toHaveBeenCalledTimes(2); // NO 3rd body execution
    expect(cost).toHaveBeenCalledTimes(2);
  });

  it('an exhausted budget (assertAllowed throws) halts and bills only k', async () => {
    const assertAllowed = vi.fn(async (i: number) => {
      if (i >= 3) {
        throw new GovernanceError('budget', {
          period: 'daily',
          limit_usd: 5,
          current_usd: 5,
        });
      }
    });
    const run = vi.fn(async (_i: number, s: number) => ({
      state: s + 1,
      decision: 'continue' as const,
    }));
    const cost = vi.fn(async () => undefined);
    const res = await runBoundedLoop(
      hooks({
        maxIterations: 5,
        assertAllowed,
        runIteration: run,
        recordIterationCost: cost,
      }),
    );
    expect(res.haltedBy).toBe('budget');
    expect(res.iterationsRun).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(cost).toHaveBeenCalledTimes(2);
    expect(res.governanceError).toBeInstanceOf(GovernanceError);
  });

  it('a kill-switch GovernanceError from assertAllowed maps to halt=kill_switch', async () => {
    const assertAllowed = vi.fn(async (i: number) => {
      if (i >= 2) throw new GovernanceError('killed', { scope: 'project' });
    });
    const res = await runBoundedLoop(
      hooks({ maxIterations: 5, assertAllowed }),
    );
    expect(res.haltedBy).toBe('kill_switch');
    expect(res.iterationsRun).toBe(1);
  });

  it('checks killSwitch THEN assertAllowed THEN runIteration THEN cost — gates are not bypassable', async () => {
    const order: string[] = [];
    const res = await runBoundedLoop(
      hooks({
        maxIterations: 3,
        killSwitchActive: async () => {
          order.push('kill');
          return false;
        },
        assertAllowed: async () => {
          order.push('assert');
        },
        runIteration: async (i, s) => {
          order.push('run');
          return { state: s + 1, decision: i === 1 ? 'break' : 'continue' };
        },
        recordIterationCost: async () => {
          order.push('cost');
        },
      }),
    );
    expect(res.haltedBy).toBe('break');
    // Exactly one iteration's worth, in the contract order.
    expect(order).toEqual(['kill', 'assert', 'run', 'cost']);
  });

  it('records each iteration with its 1-indexed number (pay-per-use ledger)', async () => {
    const seen: number[] = [];
    await runBoundedLoop(
      hooks({
        maxIterations: 10,
        runIteration: async (i, s) => ({
          state: s + 1,
          decision: i === 3 ? 'break' : 'continue',
        }),
        recordIterationCost: async (i) => {
          seen.push(i);
        },
      }),
    );
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('runBoundedLoop — error propagation', () => {
  it('a NON-governance throw from a hook propagates (real bugs surface)', async () => {
    await expect(
      runBoundedLoop(
        hooks({
          runIteration: async () => {
            throw new Error('boom');
          },
        }),
      ),
    ).rejects.toThrow('boom');
  });
});
