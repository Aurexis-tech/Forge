// Hermetic e2e — bounded CLARIFICATION LOOP.
//
// Drives the loop with STUBBED extract + ask seams (no LLM, no
// network, no DB). Asserts:
//
//   - Per-round governance scope is threaded correctly.
//   - Audit hooks fire once per round (and exactly once for the
//     terminal max-reached / resolved event).
//   - The MAX cap is enforced — when uncertainty never converges,
//     the loop exits cleanly at the cap.
//   - When uncertainty drops below the threshold mid-loop, the
//     loop terminates 'converged' before hitting the cap.
//   - Short-circuit: when the initial extraction already has
//     nothing actionable, the loop emits zero rounds and
//     terminates 'no_actionable'.
//   - Zero real fetch.

import { describe, expect, it, vi } from 'vitest';
import {
  runClarificationLoop,
  type ExtractForLoop,
} from '@/lib/engine/spec/clarification-loop';
import type { GovernanceScope } from '@/lib/engine/llm';

// ---------------------------------------------------------------------------
// Helpers — minimal SoftwareSpec-shaped objects for the loop. The
// loop only cares about WHAT THE CONFIDENCE COMPUTE LABELS — we
// craft specs whose confidence map exercises the leverage table.
// ---------------------------------------------------------------------------

const baseSoftwareSpec = (overrides: Partial<{
  goal: string;
  pages: ReadonlyArray<{ id: string; name: string; purpose: string }>;
  entities: ReadonlyArray<{ name: string; fields: ReadonlyArray<{ name: string; type: string }> }>;
  flows: ReadonlyArray<{ name: string; description: string }>;
  requiresAuth: boolean;
  perUserIsolation: boolean;
}> = {}) => ({
  goal: overrides.goal ?? 'a small app',
  pages: overrides.pages ?? [],
  entities: overrides.entities ?? [],
  flows: overrides.flows ?? [],
  auth: {
    requires_auth: overrides.requiresAuth ?? true,
    per_user_isolation: overrides.perUserIsolation ?? true,
  },
  integrations: [],
});

const governance: GovernanceScope = {
  user_id: 'test-user',
  project_id: 'test-project',
  ref: 'spec.clarification.test',
};

// ===========================================================================
// MAX-ROUNDS CAP
// ===========================================================================
describe('runClarificationLoop — max cap enforced', () => {
  it('terminates at maxRounds=2 when uncertainty never converges', async () => {
    // Stub extractor ALWAYS returns a spec with missing entities —
    // a 100-leverage gap that the loop will keep asking about. The
    // stub ignores the intent so the gap never closes.
    const extract: ExtractForLoop = vi.fn(async () => ({
      spec: baseSoftwareSpec({
        pages: [{ id: 'list', name: 'List', purpose: 'List things' }],
      }),
    }));
    const ask = vi.fn(async (_q: string) => 'the user answers a thing');
    const auditRound = vi.fn();
    const auditMaxReached = vi.fn();
    const auditResolved = vi.fn();

    const result = await runClarificationLoop({
      intent: 'build me an app',
      mold: 'software',
      extract,
      ask,
      governance,
      audit: {
        round: auditRound,
        maxReached: auditMaxReached,
        resolved: auditResolved,
      },
      maxRounds: 2,
    });

    expect(result.terminated).toBe('max_rounds_reached');
    expect(result.rounds.length).toBe(2);
    // Extractor: 1 initial + 1 per round = 3 total.
    const extractMock = extract as unknown as ReturnType<typeof vi.fn>;
    expect(extractMock.mock.calls.length).toBe(3);
    expect(ask.mock.calls.length).toBe(2);
    // Audit hooks: one per round, plus exactly one max-reached
    // (and never the resolved event).
    expect(auditRound.mock.calls.length).toBe(2);
    expect(auditMaxReached.mock.calls.length).toBe(1);
    expect(auditResolved.mock.calls.length).toBe(0);
  });

  it("audit round hook receives round number + field clarified", async () => {
    const extract = vi.fn(async () => ({
      spec: baseSoftwareSpec(),
    }));
    const ask = vi.fn(async () => 'answer');
    const auditRound = vi.fn();
    await runClarificationLoop({
      intent: 'a thing',
      mold: 'software',
      extract,
      ask,
      governance,
      audit: { round: auditRound },
      maxRounds: 1,
    });
    expect(auditRound.mock.calls.length).toBe(1);
    const event = auditRound.mock.calls[0]?.[0];
    expect(event?.round).toBe(1);
    expect(event?.field).toBeDefined();
    expect(typeof event?.field).toBe('string');
  });
});

// ===========================================================================
// CONVERGENCE
// ===========================================================================
describe('runClarificationLoop — converges when uncertainty drops', () => {
  it("terminates 'converged' once stub closes the gap", async () => {
    // Initial intent carries anchors for auth (login) + per-user
    // isolation (own) + the page names so the only high-leverage
    // uncertainty is the missing entities — exactly what the
    // clarification round resolves.
    const initialIntent =
      'A login-gated expense tracker app. Each user sees their own expenses on a list page, can add new expenses on an add page, and can drill into one on a detail page.';
    let call = 0;
    const extract: ExtractForLoop = async () => {
      call += 1;
      if (call === 1) {
        // Round 0: entities missing (100-leverage gap). Pages +
        // auth resolve from the intent — only entities is actionable.
        return {
          spec: baseSoftwareSpec({
            goal: 'expense tracker',
            pages: [
              { id: 'list_expenses', name: 'List expenses', purpose: 'List own expenses' },
              { id: 'add_expense', name: 'Add expense', purpose: 'Add a new expense' },
              { id: 'detail_expense', name: 'Detail', purpose: 'Drill into one expense' },
            ],
          }),
        };
      }
      // Round 1: stub closes the entities gap. flows stays empty
      // (leverage 60 — below threshold; not actionable).
      return {
        spec: baseSoftwareSpec({
          goal: 'expense tracker',
          pages: [
            { id: 'list_expenses', name: 'List expenses', purpose: 'List own expenses' },
            { id: 'add_expense', name: 'Add expense', purpose: 'Add a new expense' },
            { id: 'detail_expense', name: 'Detail', purpose: 'Drill into one expense' },
          ],
          entities: [
            {
              name: 'Expense',
              fields: [
                { name: 'amount', type: 'number' },
                { name: 'currency', type: 'string' },
                { name: 'category', type: 'string' },
                { name: 'description', type: 'text' },
              ],
            },
          ],
        }),
      };
    };
    const ask = vi.fn(async () => 'expense has amount, currency, category, description');
    const auditResolved = vi.fn();
    const auditMaxReached = vi.fn();

    const result = await runClarificationLoop({
      intent: initialIntent,
      mold: 'software',
      extract,
      ask,
      governance,
      audit: { resolved: auditResolved, maxReached: auditMaxReached },
      maxRounds: 2,
    });

    expect(result.terminated).toBe('converged');
    expect(result.rounds.length).toBe(1);
    expect(auditResolved.mock.calls.length).toBe(1);
    expect(auditMaxReached.mock.calls.length).toBe(0);
  });
});

// ===========================================================================
// SHORT-CIRCUIT
// ===========================================================================
describe('runClarificationLoop — short-circuits on no-actionable initial', () => {
  it("emits zero rounds + terminates 'no_actionable' when initial spec is rich", async () => {
    // Intent carries anchors for auth (login) + isolation (own)
    // and names the entity (Thing) so every high-leverage field
    // resolves as 'stated'.
    const intent =
      'A login-gated app with one entity Thing. Each user sees their own things on a home page.';
    const extract: ExtractForLoop = async () => ({
      spec: baseSoftwareSpec({
        goal: 'thing tracker',
        pages: [{ id: 'home', name: 'Home', purpose: 'Home page for own things' }],
        entities: [
          {
            name: 'Thing',
            fields: [
              { name: 'name', type: 'string' },
              { name: 'description', type: 'text' },
            ],
          },
        ],
        flows: [{ name: 'view', description: 'view things' }],
      }),
    });
    const ask = vi.fn(async () => 'never called');
    const result = await runClarificationLoop({
      intent,
      mold: 'software',
      extract,
      ask,
      governance,
      maxRounds: 5,
    });
    expect(result.terminated).toBe('no_actionable');
    expect(result.rounds.length).toBe(0);
    expect(ask).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GOVERNANCE THREADING
// ===========================================================================
describe('runClarificationLoop — threads governance per round', () => {
  it("appends a per-round ref to the base governance.ref", async () => {
    const refs: string[] = [];
    const extract: ExtractForLoop = async (_intent, gov) => {
      refs.push(gov.ref ?? '');
      return { spec: baseSoftwareSpec() };
    };
    const ask = vi.fn(async () => 'answer');
    await runClarificationLoop({
      intent: 'x',
      mold: 'software',
      extract,
      ask,
      governance,
      maxRounds: 2,
    });
    // initial + 2 rounds = 3 extractor calls; each carries a
    // distinct ref derived from the base.
    expect(refs.length).toBe(3);
    expect(refs[0]).toContain('initial');
    expect(refs[1]).toContain('round.1');
    expect(refs[2]).toContain('round.2');
    expect(refs.every((r) => r.startsWith(governance.ref ?? '')));
  });
});

// ===========================================================================
// PHRASE HOOK
// ===========================================================================
describe('runClarificationLoop — optional phraser polishes the template', () => {
  it("uses the phraser's output as the asked question when present", async () => {
    const extract: ExtractForLoop = async () => ({
      spec: baseSoftwareSpec(),
    });
    const ask = vi.fn(async (q: string) => {
      expect(q).toBe('REPHRASED QUESTION');
      return 'answer';
    });
    const phrase = vi.fn(async (_t: string, _g: GovernanceScope) => 'REPHRASED QUESTION');
    await runClarificationLoop({
      intent: 'x',
      mold: 'software',
      extract,
      ask,
      phrase,
      governance,
      maxRounds: 1,
    });
    expect(phrase).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// HERMETICITY
// ===========================================================================
describe('runClarificationLoop hermeticity', () => {
  it('no real fetch was issued', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
