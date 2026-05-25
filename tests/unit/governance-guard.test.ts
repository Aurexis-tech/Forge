// Unit test: governance guard (assertAllowed) — THE fail-closed gate.
//
// This is the single most important test in the suite. The Forge's
// safety story rests on this function refusing to allow ANY autonomous
// action when:
//   - the kill switch is engaged (at any applicable scope), OR
//   - the user's hard-cap budget would be breached by the projected
//     spend, OR
//   - we simply can't read governance state for any reason (the
//     fail-closed catch-all — internal_check_failed).
//
// If any of these stops behaving the user loses runaway-cost protection.
// Every branch here must hold.

import { describe, expect, it } from 'vitest';
import {
  assertAllowed,
  GovernanceError,
} from '@/lib/engine/governance/guard';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

function client(db: InMemoryDb) {
  // The InMemoryClient has the same .from() surface assertAllowed uses;
  // cast to the production ForgeSupabase shape (which is just
  // SupabaseClient untyped) at the boundary.
  return makeClient(db) as unknown as Parameters<typeof assertAllowed>[1];
}

const USER = 'user-test-1';
const PROJECT = 'project-test-1';

describe('assertAllowed', () => {
  it('allows when there is no kill switch and no budget', async () => {
    const db = createInMemoryDb();
    const result = await assertAllowed(
      { user_id: USER, project_id: PROJECT, projectedCostUsd: 0.05 },
      client(db),
    );
    expect(result.ok).toBe(true);
    expect(result.budget).toBeNull();
  });

  it('allows when under budget', async () => {
    const db = createInMemoryDb();
    db.tables.budgets = [
      {
        id: 'b1',
        user_id: USER,
        period: 'daily',
        limit_usd: 5.0,
        hard_cap: true,
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.cost_events = [
      {
        id: 'c1',
        user_id: USER,
        project_id: PROJECT,
        kind: 'llm',
        amount_usd: 1.0,
        created_at: new Date().toISOString(),
      },
    ];
    const result = await assertAllowed(
      { user_id: USER, project_id: PROJECT, projectedCostUsd: 0.5 },
      client(db),
    );
    expect(result.ok).toBe(true);
  });

  it('BLOCKS when the projected spend would exceed the daily cap', async () => {
    const db = createInMemoryDb();
    db.tables.budgets = [
      {
        id: 'b1',
        user_id: USER,
        period: 'daily',
        limit_usd: 5.0,
        hard_cap: true,
        created_at: new Date().toISOString(),
      },
    ];
    // Current spend already at 4.80; this action projects 0.30 →
    // total 5.10 ≥ 5.00 → block.
    db.tables.cost_events = [
      {
        id: 'c1',
        user_id: USER,
        kind: 'llm',
        amount_usd: 4.80,
        created_at: new Date().toISOString(),
      },
    ];
    await expect(
      assertAllowed(
        { user_id: USER, project_id: PROJECT, projectedCostUsd: 0.30 },
        client(db),
      ),
    ).rejects.toMatchObject({
      name: 'GovernanceError',
      reason: 'budget',
    });
  });

  it('BLOCKS when the GLOBAL kill switch is engaged', async () => {
    const db = createInMemoryDb();
    db.tables.kill_switches = [
      {
        id: 'k1',
        scope: 'global',
        scope_id: null,
        active: true,
        reason: 'maintenance',
        set_by: 'ops',
        created_at: new Date().toISOString(),
      },
    ];
    await expect(
      assertAllowed(
        { user_id: USER, project_id: PROJECT, projectedCostUsd: 0.05 },
        client(db),
      ),
    ).rejects.toMatchObject({
      name: 'GovernanceError',
      reason: 'killed',
    });
  });

  it('BLOCKS when a USER-scope kill switch is engaged for this user', async () => {
    const db = createInMemoryDb();
    db.tables.kill_switches = [
      {
        id: 'k1',
        scope: 'user',
        scope_id: USER,
        active: true,
        reason: 'user requested pause',
        set_by: 'user',
        created_at: new Date().toISOString(),
      },
    ];
    await expect(
      assertAllowed(
        { user_id: USER, project_id: PROJECT, projectedCostUsd: 0.05 },
        client(db),
      ),
    ).rejects.toMatchObject({
      name: 'GovernanceError',
      reason: 'killed',
    });
  });

  it('FAIL-CLOSED: blocks when governance state cannot be read', async () => {
    // THIS IS THE MOST IMPORTANT ASSERTION IN THE SUITE.
    //
    // If the DB call fails (RLS surprise, network blip, supabase down,
    // anything), assertAllowed MUST refuse the action. Allowing through
    // on an unreadable state would defeat every kill switch + budget cap.
    const db = createInMemoryDb();
    db.forceReadError = new Error('simulated db outage');
    try {
      await assertAllowed(
        { user_id: USER, project_id: PROJECT, projectedCostUsd: 0.05 },
        client(db),
      );
      throw new Error(
        'assertAllowed must REFUSE when governance state is unreadable — ' +
          'it returned success instead. This is a fail-open regression.',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(GovernanceError);
      const ge = err as GovernanceError;
      // The CRITICAL assertion: an unreadable governance state becomes
      // 'internal_check_failed', not a silent allow. Detail.error is
      // populated for ops debugging; its precise stringified shape
      // depends on what the DB layer threw (plain object → '[object
      // Object]' under String(), an Error → the message). The shape
      // doesn't matter to safety — the refusal does.
      expect(ge.reason).toBe('internal_check_failed');
      expect(ge.detail).toHaveProperty('error');
    }
  });

  it('BYOK skips the budget cap but still respects the kill switch', async () => {
    const db = createInMemoryDb();
    // Budget cap that would normally block.
    db.tables.budgets = [
      {
        id: 'b1',
        user_id: USER,
        period: 'daily',
        limit_usd: 0.10,
        hard_cap: true,
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.cost_events = [
      {
        id: 'c1',
        user_id: USER,
        kind: 'llm',
        amount_usd: 0.50,
        created_at: new Date().toISOString(),
      },
    ];
    // BYOK with no kill switch → should allow despite over-budget.
    const ok = await assertAllowed(
      {
        user_id: USER,
        project_id: PROJECT,
        projectedCostUsd: 1.0,
        keySource: 'byok',
      },
      client(db),
    );
    expect(ok.ok).toBe(true);

    // Same scenario but with a kill switch → MUST still block.
    db.tables.kill_switches = [
      {
        id: 'k1',
        scope: 'global',
        scope_id: null,
        active: true,
        reason: 'paused',
        set_by: 'ops',
        created_at: new Date().toISOString(),
      },
    ];
    await expect(
      assertAllowed(
        {
          user_id: USER,
          project_id: PROJECT,
          projectedCostUsd: 1.0,
          keySource: 'byok',
        },
        client(db),
      ),
    ).rejects.toMatchObject({
      name: 'GovernanceError',
      reason: 'killed',
    });
  });

  it('ignores non-hard-cap (soft) budgets', async () => {
    const db = createInMemoryDb();
    db.tables.budgets = [
      {
        id: 'b1',
        user_id: USER,
        period: 'daily',
        limit_usd: 0.01,
        hard_cap: false,
        created_at: new Date().toISOString(),
      },
    ];
    db.tables.cost_events = [
      {
        id: 'c1',
        user_id: USER,
        kind: 'llm',
        amount_usd: 100.0,
        created_at: new Date().toISOString(),
      },
    ];
    const ok = await assertAllowed(
      { user_id: USER, project_id: PROJECT, projectedCostUsd: 50 },
      client(db),
    );
    expect(ok.ok).toBe(true);
  });
});
