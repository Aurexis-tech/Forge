// Cost-ceiling evaluator for the Phase 4-4 preview gate.
//
// The infra mold is the ONLY place in the engine where the budget cap
// gates a FORWARD action by a PROJECTED cost rather than by accumulated
// spend. The agent/system/software molds bill per-call against a
// running ledger; infrastructure projections the cost upfront because
// once you `terraform apply` you're committed to the bill.
//
// This module is the gate half of P4-4. It:
//
//   1. Reads the user's budget rows (lib/engine/governance/budgets)
//   2. Compares the projected MONTHLY USD estimate against the
//      monthly cap (and the equivalent daily figure against a daily
//      cap, if one's set)
//   3. Returns a verdict (within_budget / over_budget) the route
//      persists + the UI surfaces.
//
// A within-budget verdict UNLOCKS provisioning (P4-5 is still gated
// by its own typed destructive-confirm). An over-budget verdict
// BLOCKS provisioning — the user must raise the ceiling or trim the
// spec before any apply can fire.
//
// NO ledger writes. NO cloud calls. Pure evaluation.

import type { ForgeSupabase } from '@/lib/supabase';
import { listBudgets } from '@/lib/engine/governance/budgets';
import type { Budget } from '@/lib/types';

export type CeilingVerdict = 'within_budget' | 'over_budget' | 'no_budget_set';

export interface CeilingCheck {
  verdict: CeilingVerdict;
  // The strictest cap (lowest projected headroom) — the one that
  // blocked the preview. Null when no caps are set.
  binding_period: 'monthly' | 'daily' | null;
  binding_limit_usd: number | null;
  // Projected cost over the binding window (so a daily-cap
  // comparison gets the daily figure).
  projected_usd_for_binding: number | null;
  // The aggregated monthly figure — surfaced in the UI regardless of
  // which window bound the verdict.
  projected_usd_per_month: number;
  // Human-readable explanation for the audit + UI.
  message: string;
}

export interface EvaluateCeilingInput {
  userId: string;
  projectedUsdPerMonth: number;
  // Optional: skip budget lookup and use these rows directly. The
  // route layer passes through to listBudgets when omitted; the unit
  // tests supply rows directly so they don't need a stubbed client.
  budgets?: Budget[];
  supabase?: ForgeSupabase;
}

const DAYS_PER_MONTH = 30.4375;

/**
 * Evaluate the projected monthly cost against the user's budget caps.
 *
 * - The MONTHLY cap is compared to the projected MONTHLY figure
 *   directly.
 * - The DAILY cap is compared to projected_monthly / DAYS_PER_MONTH.
 * - If multiple hard caps apply, the strictest one (highest projected/
 *   limit ratio) is reported as the binding cap.
 * - Non-hard-cap (advisory) budgets are IGNORED here — preview-time
 *   blocking is a hard-cap-only action.
 */
export async function evaluateCostCeiling(
  input: EvaluateCeilingInput,
): Promise<CeilingCheck> {
  const projectedMonthly = Math.max(0, input.projectedUsdPerMonth);
  const projectedDaily = projectedMonthly / DAYS_PER_MONTH;

  let budgets = input.budgets ?? null;
  if (!budgets) {
    if (!input.supabase) {
      throw new Error(
        'evaluateCostCeiling needs either { budgets } or { supabase }',
      );
    }
    budgets = await listBudgets(input.userId, input.supabase);
  }

  const hardCaps = budgets.filter((b) => b.hard_cap);
  if (hardCaps.length === 0) {
    return {
      verdict: 'no_budget_set',
      binding_period: null,
      binding_limit_usd: null,
      projected_usd_for_binding: null,
      projected_usd_per_month: projectedMonthly,
      message:
        'No hard-cap budget is set. Provisioning is unlocked, but you should set a monthly cap before applying — the estimate is ' +
        formatUsd(projectedMonthly) +
        '/mo.',
    };
  }

  // Identify the strictest cap by headroom ratio.
  let strictestRatio = -Infinity;
  let bindingPeriod: 'monthly' | 'daily' | null = null;
  let bindingLimit: number | null = null;
  let bindingProjected: number | null = null;

  for (const b of hardCaps) {
    const limit = Number(b.limit_usd);
    if (!Number.isFinite(limit) || limit < 0) continue;
    const projected = b.period === 'daily' ? projectedDaily : projectedMonthly;
    // Avoid div/0 — a zero limit is treated as "anything goes over".
    const ratio = limit === 0 ? Infinity : projected / limit;
    if (ratio > strictestRatio) {
      strictestRatio = ratio;
      bindingPeriod = b.period === 'daily' ? 'daily' : 'monthly';
      bindingLimit = limit;
      bindingProjected = projected;
    }
  }

  if (
    bindingLimit == null ||
    bindingProjected == null ||
    bindingPeriod == null
  ) {
    // Defensive — should be unreachable when hardCaps.length > 0.
    return {
      verdict: 'no_budget_set',
      binding_period: null,
      binding_limit_usd: null,
      projected_usd_for_binding: null,
      projected_usd_per_month: projectedMonthly,
      message:
        'Budget rows present but no usable hard cap; treat as no ceiling set.',
    };
  }

  const over = bindingProjected > bindingLimit;
  if (over) {
    return {
      verdict: 'over_budget',
      binding_period: bindingPeriod,
      binding_limit_usd: bindingLimit,
      projected_usd_for_binding: round2(bindingProjected),
      projected_usd_per_month: projectedMonthly,
      message:
        'Estimated ' +
        formatUsd(projectedMonthly) +
        '/mo (' +
        formatUsd(bindingProjected) +
        ' against your ' +
        bindingPeriod +
        ' cap of ' +
        formatUsd(bindingLimit) +
        '). Provisioning is BLOCKED — raise the ceiling or trim the spec to proceed.',
    };
  }

  return {
    verdict: 'within_budget',
    binding_period: bindingPeriod,
    binding_limit_usd: bindingLimit,
    projected_usd_for_binding: round2(bindingProjected),
    projected_usd_per_month: projectedMonthly,
    message:
      'Estimated ' +
      formatUsd(projectedMonthly) +
      '/mo (' +
      formatUsd(bindingProjected) +
      ' within your ' +
      bindingPeriod +
      ' cap of ' +
      formatUsd(bindingLimit) +
      '). Provisioning is unlocked — still gated by the P4-5 typed confirm.',
  };
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0';
  if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + (Math.round(n * 100) / 100).toFixed(2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
