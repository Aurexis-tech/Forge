// DB helpers for budgets. Kept thin; the guard reads via these too.

import { getServerSupabase, type ForgeSupabase } from '@/lib/supabase';
import type { Budget, BudgetPeriod } from '@/lib/types';

export async function listBudgets(
  userId: string,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<Budget[]> {
  const { data, error } = await supabase
    .from('budgets')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []) as Budget[];
}

export async function upsertBudget(
  args: {
    userId: string;
    period: BudgetPeriod;
    /**
     * Canonical USD limit — what the governance guard compares against.
     * Computed at the route layer from (amount, displayCurrency) via
     * lib/fx.toUsd so the DB never depends on live FX.
     */
    limitUsd: number;
    hardCap?: boolean;
    /**
     * ISO-4217 currency the user typed the limit in. UI-only — does not
     * affect enforcement. Defaults to 'USD' if omitted (legacy callers).
     */
    displayCurrency?: string;
  },
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<Budget> {
  const { data, error } = await supabase
    .from('budgets')
    .upsert(
      {
        user_id: args.userId,
        period: args.period,
        limit_usd: args.limitUsd,
        hard_cap: args.hardCap ?? true,
        display_currency: (args.displayCurrency ?? 'USD').toUpperCase(),
      },
      { onConflict: 'user_id,period' },
    )
    .select('*')
    .single();
  if (error || !data) throw error ?? new Error('failed to upsert budget');
  return data as Budget;
}

export async function deleteBudget(
  args: { userId: string; period: BudgetPeriod },
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<void> {
  const { error } = await supabase
    .from('budgets')
    .delete()
    .eq('user_id', args.userId)
    .eq('period', args.period);
  if (error) throw error;
}
