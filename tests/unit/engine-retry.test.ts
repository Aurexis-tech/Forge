// Hermetic unit test — withRetry helper.
//
// Sleep is mocked via the `sleepImpl` option so tests run in real
// time but still observe the requested ms.

import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '@/lib/engine/retry';
import { EngineError } from '@/lib/engine/errors';

// Small helper: build a never-sleep impl that records what it was asked.
function buildSleepRecorder() {
  const calls: number[] = [];
  return {
    impl: async (ms: number) => {
      calls.push(ms);
    },
    calls,
  };
}

// ===========================================================================
// HAPPY PATH
// ===========================================================================
describe('withRetry — happy path', () => {
  it('returns the value when fn succeeds on attempt 1; no sleep, no retry', async () => {
    const sleep = buildSleepRecorder();
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { sleepImpl: sleep.impl });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep.calls.length).toBe(0);
    // attemptRef is '' on first attempt.
    const ctx = (fn.mock.calls as unknown[][])[0]?.[0] as
      | { attempt?: number; attemptRef?: string }
      | undefined;
    expect(ctx?.attempt).toBe(1);
    expect(ctx?.attemptRef).toBe('');
  });
});

// ===========================================================================
// TRANSIENT RETRY
// ===========================================================================
describe('withRetry — transient retry', () => {
  it('retries up to maxAttempts then throws the classified error', async () => {
    const sleep = buildSleepRecorder();
    const fn = vi.fn(async () => {
      // 503 is transient_provider → retriable.
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    });
    await expect(
      withRetry(fn, { maxAttempts: 3, sleepImpl: sleep.impl, jitter: false }),
    ).rejects.toMatchObject({
      category: 'transient_provider',
      retriable: true,
    });
    expect(fn).toHaveBeenCalledTimes(3);
    // Two sleeps between three attempts. Geometric base=500, factor=2,
    // so 500 + 1000.
    expect(sleep.calls).toEqual([500, 1000]);
  });

  it('succeeds on the third attempt after two transients', async () => {
    let n = 0;
    const sleep = buildSleepRecorder();
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) {
        throw Object.assign(new Error('5xx'), { status: 502 });
      }
      return 'finally';
    });
    const result = await withRetry(fn, {
      maxAttempts: 3,
      sleepImpl: sleep.impl,
      jitter: false,
    });
    expect(result).toBe('finally');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("attempt context carries '.retry.N' suffixes", async () => {
    let n = 0;
    const sleep = buildSleepRecorder();
    const refs: string[] = [];
    const fn = vi.fn(async (ctx: { attempt: number; attemptRef: string }) => {
      refs.push(ctx.attemptRef);
      n += 1;
      if (n < 3) {
        throw Object.assign(new Error('5xx'), { status: 503 });
      }
      return 'ok';
    });
    await withRetry(fn, { maxAttempts: 3, sleepImpl: sleep.impl });
    expect(refs).toEqual(['', '.retry.1', '.retry.2']);
  });
});

// ===========================================================================
// PERMANENT — NO RETRY
// ===========================================================================
describe('withRetry — permanent failures', () => {
  it('400 bad_input → throws immediately; fn called once', async () => {
    const sleep = buildSleepRecorder();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('bad input'), { status: 400 });
    });
    await expect(
      withRetry(fn, { maxAttempts: 5, sleepImpl: sleep.impl }),
    ).rejects.toMatchObject({ category: 'bad_input', retriable: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep.calls.length).toBe(0);
  });

  it('401 auth → throws immediately; fn called once', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    });
    await expect(withRetry(fn)).rejects.toMatchObject({ category: 'auth' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// RETRY-AFTER HINT
// ===========================================================================
describe('withRetry — retry-after hint honoured', () => {
  it('uses retryAfterMs from the classified error over geometric backoff', async () => {
    let n = 0;
    const sleep = buildSleepRecorder();
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        throw Object.assign(new Error('rate limit'), {
          status: 429,
          retryAfter: 2, // 2 seconds → 2000 ms
        });
      }
      return 'ok';
    });
    await withRetry(fn, {
      maxAttempts: 3,
      sleepImpl: sleep.impl,
      jitter: false,
    });
    // Should sleep 2000ms (retry-after) before attempt 2, not the
    // default 500ms.
    expect(sleep.calls).toEqual([2000]);
  });
});

// ===========================================================================
// AUDIT HOOK
// ===========================================================================
describe('withRetry — audit hook', () => {
  it('fires per attempt with correct meta', async () => {
    const audit = vi.fn();
    const sleep = buildSleepRecorder();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('5xx'), { status: 503 });
    });
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        audit,
        baseRef: 'codegen.test',
        sleepImpl: sleep.impl,
        jitter: false,
      }),
    ).rejects.toBeDefined();
    // Audit fires after the failed attempt, BEFORE the sleep.
    // 3 attempts → 2 retries → 2 audit events.
    expect(audit).toHaveBeenCalledTimes(2);
    const first = audit.mock.calls[0]?.[0];
    expect(first?.attempt).toBe(1);
    expect(first?.category).toBe('transient_provider');
    expect(first?.code).toBe('http_5xx');
    expect(first?.baseRef).toBe('codegen.test');
    expect(first?.sleepMs).toBe(500);
  });

  it("audit hook throws are swallowed silently — retry continues", async () => {
    const audit = vi.fn(() => {
      throw new Error('audit exploded');
    });
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('5xx'), { status: 503 });
      return 'ok';
    });
    const result = await withRetry(fn, {
      maxAttempts: 2,
      audit,
      sleepImpl: async () => undefined,
    });
    expect(result).toBe('ok');
    expect(audit).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// BOUNDED — CEILING
// ===========================================================================
describe('withRetry — bounded by ceiling', () => {
  it('caps maxAttempts at the ceiling (6) regardless of caller', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('5xx'), { status: 503 });
    });
    await expect(
      withRetry(fn, { maxAttempts: 9999, sleepImpl: async () => undefined }),
    ).rejects.toBeDefined();
    // Ceiling = 6.
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('rejects fewer than 1 attempt by falling back to 1', async () => {
    const fn = vi.fn(async () => 'ok');
    await withRetry(fn, { maxAttempts: 0, sleepImpl: async () => undefined });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// MID-LOOP GOVERNANCE FAIL
// ===========================================================================
describe('withRetry — governance refusal mid-loop stops the retry', () => {
  it('GovernanceError from a later attempt is non-retriable and exits cleanly', async () => {
    const { GovernanceError } = await import('@/lib/engine/governance/guard');
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        // First attempt: a transient. Retry would normally happen.
        throw Object.assign(new Error('5xx'), { status: 503 });
      }
      // Second attempt: governance flipped. Loop exits.
      throw new GovernanceError('killed');
    });
    await expect(
      withRetry(fn, { maxAttempts: 5, sleepImpl: async () => undefined }),
    ).rejects.toMatchObject({
      category: 'governance',
      retriable: false,
    });
    // Only TWO attempts — the second's GovernanceError stopped the loop.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// HERMETICITY
// ===========================================================================
describe('engine-retry hermeticity', () => {
  it('no real fetch was issued', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
