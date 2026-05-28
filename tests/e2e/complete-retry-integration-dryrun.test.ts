// Hermetic integration test — complete() retries on transient 5xx
// then succeeds.
//
// What this exercises end-to-end:
//   - withRetry around the Anthropic SDK call.
//   - assertAllowed runs PER ATTEMPT (governance can refuse mid-loop).
//   - The successful attempt's recordCost ref carries '.retry.N'
//     when N >= 1 — making retry spend observable in the ledger.
//
// Stubbed: the Anthropic SDK module (via vi.mock) so the SDK call
// throws scripted errors then succeeds. resolveKey is mocked (it would
// otherwise construct a real Supabase client for BYOK lookup — see the
// mock note below). assertAllowed + recordCost are EXERCISED unchanged
// from the engine (assertAllowed via spy, recordCost via mock).

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Anthropic SDK + the cost ledger BEFORE importing the
// engine module that uses them. `vi.mock` is HOISTED above all
// imports, so the mock function refs must be declared via
// `vi.hoisted` to be available at hoist time.
const { messagesCreate, recordCostMock } = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  recordCostMock: vi.fn(async () => ({
    amount_usd: 0,
    event_id: 'fake',
  })),
}));

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class FakeAnthropic {
      messages = { create: messagesCreate };
    },
  };
});
vi.mock('@/lib/engine/governance/ledger', () => ({
  recordCost: recordCostMock,
}));

// HERMETICITY: complete() resolves the BYOK key BEFORE the SDK call,
// and resolveKey() defaults its `supabase` arg to getServerSupabase()
// — which constructs a REAL Supabase client (whose realtime layer
// throws on Node 20). This test only exercises the retry + governance
// + ledger-ref behaviour, none of which needs a real client, so we
// mock the key seam. (The global guard in tests/setup.ts now fails any
// test that lets a real client be constructed.)
vi.mock('@/lib/engine/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/keys')>();
  return {
    ...actual,
    resolveKey: vi.fn(async () => ({
      key: 'test-anthropic-key',
      source: 'platform' as const,
      key_last4: 'tkey',
    })),
  };
});

// The guard runs real — it's a pure function over its inputs and
// shorts out cleanly when supabase is the in-memory test mock.
// We DO stub assertAllowed via spy below to observe call counts.
import { complete } from '@/lib/engine/llm';
import * as guard from '@/lib/engine/governance/guard';

const assertAllowedSpy = vi.spyOn(guard, 'assertAllowed').mockResolvedValue({
  ok: true,
  currentSpendUsd: 0,
  budget: null,
});

beforeEach(() => {
  messagesCreate.mockReset();
  recordCostMock.mockClear();
  assertAllowedSpy.mockClear();
});

afterAll(() => {
  assertAllowedSpy.mockRestore();
});

describe('complete() retry integration — transient 5xx then success', () => {
  it('retries twice, then returns; ledger ref carries .retry.2', async () => {
    messagesCreate
      // attempt 1: 503
      .mockImplementationOnce(() => {
        return Promise.reject(
          Object.assign(new Error('service unavailable'), { status: 503 }),
        );
      })
      // attempt 2: 502
      .mockImplementationOnce(() => {
        return Promise.reject(
          Object.assign(new Error('bad gateway'), { status: 502 }),
        );
      })
      // attempt 3: clean response
      .mockImplementationOnce(async () => ({
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 7, output_tokens: 4 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      }));

    const result = await complete({
      messages: [{ role: 'user', content: 'hi' }],
      governance: {
        user_id: null,
        project_id: null,
        ref: 'codegen.unit-test',
      },
    });

    // Final result is the third (clean) call.
    expect(result.text).toBe('hello');
    expect(result.model).toBe('claude-sonnet-4-6');
    // SDK called 3 times.
    expect(messagesCreate).toHaveBeenCalledTimes(3);
    // assertAllowed called 3 times — PER-ATTEMPT GOVERNANCE.
    expect(assertAllowedSpy).toHaveBeenCalledTimes(3);
    // recordCost called once (after the successful attempt) with
    // the ref suffixed by .retry.2.
    expect(recordCostMock).toHaveBeenCalledTimes(1);
    const costArgs = (recordCostMock.mock.calls as unknown[][])[0]?.[0] as
      | { ref?: string }
      | undefined;
    expect(costArgs?.ref).toBe('codegen.unit-test.retry.2');
  });

  it('non-retriable 400 throws after a single attempt; no recordCost', async () => {
    messagesCreate.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('bad input'), { status: 400 })),
    );
    await expect(
      complete({
        messages: [{ role: 'user', content: 'hi' }],
        governance: {
          user_id: null,
          project_id: null,
          ref: 'codegen.unit-test',
        },
      }),
    ).rejects.toBeDefined();
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(assertAllowedSpy).toHaveBeenCalledTimes(1);
    expect(recordCostMock).not.toHaveBeenCalled();
  });

  it('exhausted retries throw LLMError-shaped envelope', async () => {
    messagesCreate
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('5xx'), { status: 503 })),
      )
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('5xx'), { status: 503 })),
      )
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('5xx'), { status: 503 })),
      );
    await expect(
      complete({
        messages: [{ role: 'user', content: 'hi' }],
        governance: {
          user_id: null,
          project_id: null,
          ref: 'codegen.unit-test',
        },
      }),
    ).rejects.toThrow(/5xx|service unavailable|provider/i);
    expect(messagesCreate).toHaveBeenCalledTimes(3); // default max
  });
});

describe('complete-retry hermeticity', () => {
  it('no real fetch was issued', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
