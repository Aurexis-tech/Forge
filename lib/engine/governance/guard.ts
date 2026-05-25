// THE governance guard. Every cost-incurring or autonomous code path must
// call assertAllowed() before doing the work. There is no path that bypasses
// it — adding one is a security regression.
//
// FAIL CLOSED: any internal error (DB unreachable, RLS surprise, anything)
// becomes a GovernanceError('internal_check_failed'). We refuse the action
// rather than letting an unbounded path run.

import { getServerSupabase, type ForgeSupabase } from '@/lib/supabase';
import type { Budget, BudgetPeriod, KeySource } from '@/lib/types';
import { getSpendUsd } from './ledger';
import { activeKillSwitch } from './killswitch';

export type GovernanceBlockReason =
  | 'killed'        // kill switch active
  | 'budget'        // budget cap would be exceeded
  | 'internal_check_failed'; // fail-closed catch-all

export class GovernanceError extends Error {
  readonly reason: GovernanceBlockReason;
  readonly detail: Record<string, unknown>;
  constructor(reason: GovernanceBlockReason, detail: Record<string, unknown> = {}) {
    super('governance:' + reason);
    this.name = 'GovernanceError';
    this.reason = reason;
    this.detail = detail;
  }
}

export interface AssertAllowedInput {
  user_id: string | null;
  project_id?: string | null;
  // Best-effort estimate of what this action will cost. Used for budget
  // headroom checks before the call actually happens. Pass 0 for actions
  // that are not directly cost-incurring but should still respect the
  // kill switch (e.g. activate).
  projectedCostUsd?: number;
  // Whose fuel pays for this action. When 'byok' (user's own key), we
  // skip the budget cap — they're paying their provider directly. The
  // kill switch + fail-closed posture STILL applies regardless.
  //
  // Defaults to 'platform' to keep the safe assumption for legacy callers
  // that don't yet thread keySource through.
  keySource?: KeySource;
}

export interface AssertAllowedResult {
  ok: true;
  // The budget that constrained us (if any) — handy for UI surfacing.
  budget?: Budget | null;
  currentSpendUsd?: number;
}

export async function assertAllowed(
  input: AssertAllowedInput,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<AssertAllowedResult> {
  try {
    const kill = await activeKillSwitch(
      { userId: input.user_id, projectId: input.project_id ?? null },
      supabase,
    );
    if (kill) {
      throw new GovernanceError('killed', {
        scope: kill.scope,
        scope_id: kill.scope_id,
        reason: kill.reason,
      });
    }

    if (!input.user_id) {
      // No user → no budget to check. Kill switches above still apply.
      return { ok: true, budget: null };
    }

    // BYOK skips the budget cap — the user is paying the provider directly.
    // The kill switch was checked above, so this is still a controlled path.
    if (input.keySource === 'byok') {
      return { ok: true, budget: null };
    }

    // Budget cap. The strictest cap (lowest headroom) wins.
    const budgets = await loadActiveBudgets(input.user_id, supabase);
    if (budgets.length === 0) {
      return { ok: true, budget: null };
    }

    const projected = Math.max(0, input.projectedCostUsd ?? 0);
    for (const b of budgets) {
      if (!b.hard_cap) continue;
      const spend = await getSpendUsd(
        input.user_id,
        b.period as BudgetPeriod,
        supabase,
      );
      if (spend + projected >= Number(b.limit_usd)) {
        throw new GovernanceError('budget', {
          period: b.period,
          limit_usd: Number(b.limit_usd),
          current_usd: spend,
          projected_usd: projected,
        });
      }
    }

    return { ok: true, budget: budgets[0] ?? null };
  } catch (err) {
    if (err instanceof GovernanceError) throw err;
    // FAIL CLOSED — anything we didn't anticipate becomes a block.
    const message = err instanceof Error ? err.message : String(err);
    throw new GovernanceError('internal_check_failed', { error: message });
  }
}

async function loadActiveBudgets(
  userId: string,
  supabase: ForgeSupabase,
): Promise<Budget[]> {
  const { data, error } = await supabase
    .from('budgets')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []) as Budget[];
}

// Translate a GovernanceError to a clean HTTP response shape the route
// handlers can return verbatim.
export function governanceBlockResponse(err: GovernanceError): {
  status: number;
  body: { error: string; reason: GovernanceBlockReason; detail: Record<string, unknown> };
} {
  const status = err.reason === 'killed' ? 503 : 402;
  return {
    status,
    body: {
      error: humanMessage(err),
      reason: err.reason,
      detail: err.detail,
    },
  };
}

function humanMessage(err: GovernanceError): string {
  switch (err.reason) {
    case 'killed': {
      const scope = String(err.detail.scope ?? 'global');
      const reason = err.detail.reason ? ' (' + err.detail.reason + ')' : '';
      return 'The Forge is paused by the ' + scope + ' kill switch' + reason + '.';
    }
    case 'budget': {
      const cap = Number(err.detail.limit_usd ?? 0).toFixed(2);
      const cur = Number(err.detail.current_usd ?? 0).toFixed(2);
      return (
        'Action blocked: current spend ($' +
        cur +
        ') plus this action would exceed your ' +
        String(err.detail.period ?? 'budget') +
        ' cap ($' +
        cap +
        ').'
      );
    }
    case 'internal_check_failed':
      return 'Governance check failed; action blocked (fail-closed).';
  }
}
