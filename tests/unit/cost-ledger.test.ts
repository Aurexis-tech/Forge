// Unit test: cost ledger arithmetic.
//
// Every cost event runs through computeAmountUsd → llmCostUsd /
// sandboxCostUsd / runtimeCostUsd. These tests verify the formulas
// match the per-MTok constants in lib/engine/governance/pricing.ts so a
// rate edit can't silently change billing math.

import { describe, expect, it } from 'vitest';
import { computeAmountUsd } from '@/lib/engine/governance/ledger';
import {
  CLAUDE_HAIKU_4_5,
  CLAUDE_SONNET_4_6,
  CLAUDE_OPUS_4_7,
  E2B_SANDBOX_USD_PER_HOUR,
  llmCostUsd,
  sandboxCostUsd,
  runtimeCostUsd,
} from '@/lib/engine/governance/pricing';

const MTOK = 1_000_000;
const APPROX = (n: number) => expect.closeTo(n, 9);

describe('llmCostUsd', () => {
  it('claude-haiku-4-5: input + output rates compose linearly', () => {
    // 500k input tokens + 200k output tokens at haiku rates.
    const expected =
      (500_000 / MTOK) * CLAUDE_HAIKU_4_5.input_per_mtok +
      (200_000 / MTOK) * CLAUDE_HAIKU_4_5.output_per_mtok;
    expect(llmCostUsd('claude-haiku-4-5', 500_000, 200_000)).toEqual(
      APPROX(expected),
    );
  });

  it('claude-sonnet-4-6: 1M+1M tokens = input_per_mtok + output_per_mtok', () => {
    expect(llmCostUsd('claude-sonnet-4-6', MTOK, MTOK)).toEqual(
      APPROX(CLAUDE_SONNET_4_6.input_per_mtok + CLAUDE_SONNET_4_6.output_per_mtok),
    );
  });

  it('claude-opus-4-7: matches the per-MTok constants exactly', () => {
    // Tight check that the multiplier is on million-token units.
    expect(llmCostUsd('claude-opus-4-7', 100_000, 0)).toEqual(
      APPROX((100_000 / MTOK) * CLAUDE_OPUS_4_7.input_per_mtok),
    );
    expect(llmCostUsd('claude-opus-4-7', 0, 50_000)).toEqual(
      APPROX((50_000 / MTOK) * CLAUDE_OPUS_4_7.output_per_mtok),
    );
  });

  it('zero tokens = zero cost (regardless of model)', () => {
    expect(llmCostUsd('claude-haiku-4-5', 0, 0)).toBe(0);
    expect(llmCostUsd('claude-sonnet-4-6', 0, 0)).toBe(0);
    expect(llmCostUsd('claude-opus-4-7', 0, 0)).toBe(0);
  });
});

describe('sandboxCostUsd / runtimeCostUsd', () => {
  it('converts E2B hourly rate to per-second cost (sandbox)', () => {
    // 3600 seconds (= 1 hour) should equal exactly the per-hour rate.
    const oneHourMs = 3600 * 1000;
    expect(sandboxCostUsd(oneHourMs)).toEqual(APPROX(E2B_SANDBOX_USD_PER_HOUR));
  });

  it('runtime cost uses the same E2B per-hour rate by default', () => {
    const oneHourMs = 3600 * 1000;
    expect(runtimeCostUsd(oneHourMs)).toEqual(APPROX(E2B_SANDBOX_USD_PER_HOUR));
  });

  it('partial second compute scales linearly', () => {
    // 30 seconds of compute = 30/3600 of the per-hour rate.
    const expected = (30 / 3600) * E2B_SANDBOX_USD_PER_HOUR;
    expect(sandboxCostUsd(30_000)).toEqual(APPROX(expected));
  });

  it('negative compute clamps to zero (defence against bad inputs)', () => {
    expect(sandboxCostUsd(-1000)).toBe(0);
    expect(runtimeCostUsd(-1000)).toBe(0);
  });
});

describe('computeAmountUsd (the ledger entrypoint)', () => {
  it('llm kind: routes to llmCostUsd with the supplied token counts', () => {
    const amount = computeAmountUsd({
      user_id: 'u',
      kind: 'llm',
      model: 'claude-sonnet-4-6',
      input_tokens: 1234,
      output_tokens: 567,
    });
    expect(amount).toEqual(
      APPROX(llmCostUsd('claude-sonnet-4-6', 1234, 567)),
    );
  });

  it('llm kind with no model returns 0 (safe default — never silently bill)', () => {
    const amount = computeAmountUsd({
      user_id: 'u',
      kind: 'llm',
      model: null,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(amount).toBe(0);
  });

  it('sandbox kind: charges per compute_ms', () => {
    expect(
      computeAmountUsd({ user_id: 'u', kind: 'sandbox', compute_ms: 60_000 }),
    ).toEqual(APPROX(sandboxCostUsd(60_000)));
  });

  it('runtime kind: charges per compute_ms', () => {
    expect(
      computeAmountUsd({ user_id: 'u', kind: 'runtime', compute_ms: 60_000 }),
    ).toEqual(APPROX(runtimeCostUsd(60_000)));
  });

  it('llm + sandbox combine when summed independently (this is how runs are billed)', () => {
    // Simulates a real test run: one LLM call (haiku, small) + one
    // sandbox burn (45s). Both events go to cost_events; the ledger
    // sum across the project is the user-facing total.
    const llm = computeAmountUsd({
      user_id: 'u',
      kind: 'llm',
      model: 'claude-haiku-4-5',
      input_tokens: 800,
      output_tokens: 400,
    });
    const sandbox = computeAmountUsd({
      user_id: 'u',
      kind: 'sandbox',
      compute_ms: 45_000,
    });
    const total = llm + sandbox;
    // Sanity: both contributions are positive and the sum is the literal sum.
    expect(llm).toBeGreaterThan(0);
    expect(sandbox).toBeGreaterThan(0);
    expect(total).toEqual(APPROX(llm + sandbox));
  });
});

describe('seed pricing constants (sanity-check the Anthropic rate-card)', () => {
  // If any of these change, the seed values in pricing.ts have drifted
  // from the spec brief. Update both in lockstep.
  it('haiku 4.5 = $1/$5 per MTok', () => {
    expect(CLAUDE_HAIKU_4_5).toEqual({ input_per_mtok: 1.0, output_per_mtok: 5.0 });
  });
  it('sonnet 4.6 = $3/$15 per MTok', () => {
    expect(CLAUDE_SONNET_4_6).toEqual({ input_per_mtok: 3.0, output_per_mtok: 15.0 });
  });
  it('opus 4.7 = $5/$25 per MTok', () => {
    expect(CLAUDE_OPUS_4_7).toEqual({ input_per_mtok: 5.0, output_per_mtok: 25.0 });
  });
  it('E2B sandbox = $0.50/hr', () => {
    expect(E2B_SANDBOX_USD_PER_HOUR).toBe(0.5);
  });
});
