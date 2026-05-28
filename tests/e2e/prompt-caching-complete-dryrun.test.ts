// Hermetic integration test — complete() prompt-caching wiring.
//
// What this exercises end-to-end (with the SDK stubbed):
//   - cacheSystem:true sends `system` as ONE cache-controlled text block
//     (cache_control:{type:'ephemeral'}) — exactly one breakpoint, placed
//     on the system prefix (before any message), and NO cache_control on
//     message blocks. Respects the tools->system->messages hierarchy and
//     the <=4 breakpoint budget.
//   - cacheSystem omitted/false keeps `system` a plain string (the exact
//     pre-caching behaviour — backward compatible).
//   - The response's cache_creation_input_tokens + cache_read_input_tokens
//     are captured into result.usage AND threaded to recordCost, so the
//     ledger can measure real savings on the first real forge.
//
// Stubbed (same seams as complete-retry-integration): the Anthropic SDK,
// the cost ledger (to capture recordCost args), and resolveKey (so no
// real Supabase client is constructed).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { messagesCreate, recordCostMock } = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  recordCostMock: vi.fn(async () => ({ amount_usd: 0, event_id: 'fake' })),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: messagesCreate };
  },
}));
vi.mock('@/lib/engine/governance/ledger', () => ({
  recordCost: recordCostMock,
}));
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

import { complete } from '@/lib/engine/llm';
import * as guard from '@/lib/engine/governance/guard';

vi.spyOn(guard, 'assertAllowed').mockResolvedValue({
  ok: true,
  currentSpendUsd: 0,
  budget: null,
});

// A clean SDK response carrying cache usage fields.
function okResponse(usage: Record<string, number>) {
  return {
    content: [{ type: 'text', text: 'ok' }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    },
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
  };
}

beforeEach(() => {
  messagesCreate.mockReset();
  recordCostMock.mockClear();
});

function lastCreateArgs(): Record<string, unknown> {
  const calls = messagesCreate.mock.calls as unknown[][];
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

describe('complete({ cacheSystem: true }) — system sent as a cached block', () => {
  it('sends system as one text block with cache_control: ephemeral', async () => {
    messagesCreate.mockResolvedValueOnce(okResponse({}));
    await complete({
      system: 'STABLE SYSTEM PREFIX',
      cacheSystem: true,
      messages: [{ role: 'user', content: 'variable user content' }],
      governance: { user_id: null, project_id: null, ref: 'codegen.x' },
    });

    const args = lastCreateArgs();
    expect(Array.isArray(args.system)).toBe(true);
    const blocks = args.system as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: 'STABLE SYSTEM PREFIX',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('places EXACTLY one cache_control breakpoint, on system not messages', async () => {
    messagesCreate.mockResolvedValueOnce(okResponse({}));
    await complete({
      system: 'SYS',
      cacheSystem: true,
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ],
      governance: { user_id: null, project_id: null, ref: 'codegen.x' },
    });
    const args = lastCreateArgs();
    // Count cache_control breakpoints across the whole request.
    const serialised = JSON.stringify(args);
    const breakpoints = serialised.split('"cache_control"').length - 1;
    expect(breakpoints).toBe(1); // <= 4, and exactly the system one
    // Messages are plain {role, content:string} — no cache_control.
    const msgs = args.messages as Array<Record<string, unknown>>;
    for (const m of msgs) {
      expect(typeof m.content).toBe('string');
    }
  });

  it('captures cache usage into result.usage AND forwards it to recordCost', async () => {
    messagesCreate.mockResolvedValueOnce(
      okResponse({
        input_tokens: 12,
        cache_creation_input_tokens: 2048,
        cache_read_input_tokens: 100_000,
      }),
    );
    const res = await complete({
      system: 'SYS',
      cacheSystem: true,
      messages: [{ role: 'user', content: 'u' }],
      governance: { user_id: null, project_id: null, ref: 'codegen.x' },
    });

    expect(res.usage.cache_creation_input_tokens).toBe(2048);
    expect(res.usage.cache_read_input_tokens).toBe(100_000);

    expect(recordCostMock).toHaveBeenCalledTimes(1);
    const costArgs = (recordCostMock.mock.calls as unknown[][])[0]?.[0] as {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    expect(costArgs.cache_creation_input_tokens).toBe(2048);
    expect(costArgs.cache_read_input_tokens).toBe(100_000);
  });
});

describe('complete() without cacheSystem — backward compatible', () => {
  it('sends system as a plain string (no content-block array, no cache_control)', async () => {
    messagesCreate.mockResolvedValueOnce(okResponse({}));
    await complete({
      system: 'PLAIN SYSTEM',
      messages: [{ role: 'user', content: 'u' }],
      governance: { user_id: null, project_id: null, ref: 'codegen.x' },
    });
    const args = lastCreateArgs();
    expect(args.system).toBe('PLAIN SYSTEM');
    expect(JSON.stringify(args)).not.toContain('cache_control');
  });

  it('omits system entirely when none is provided (even with cacheSystem set)', async () => {
    messagesCreate.mockResolvedValueOnce(okResponse({}));
    await complete({
      cacheSystem: true,
      messages: [{ role: 'user', content: 'u' }],
      governance: { user_id: null, project_id: null, ref: 'codegen.x' },
    });
    const args = lastCreateArgs();
    expect('system' in args).toBe(false);
  });

  it('defaults the cache usage fields to 0 when the response omits them', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 }, // no cache fields
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });
    const res = await complete({
      system: 'SYS',
      cacheSystem: true,
      messages: [{ role: 'user', content: 'u' }],
      governance: { user_id: null, project_id: null, ref: 'codegen.x' },
    });
    expect(res.usage.cache_creation_input_tokens).toBe(0);
    expect(res.usage.cache_read_input_tokens).toBe(0);
  });
});
