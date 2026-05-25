// The cost ledger. Every cost-incurring action writes here, period.
//
// Reads are scoped per user. Writes use the service role so the ledger is
// the source of truth even if a route forgot an ownership check.

import { getServerSupabase, type ForgeSupabase } from '@/lib/supabase';
import type {
  BudgetPeriod,
  CostEvent,
  CostEventKind,
  KeySource,
} from '@/lib/types';
import {
  llmCostUsd,
  runtimeCostUsd,
  sandboxCostUsd,
} from './pricing';

export interface RecordCostInput {
  user_id: string | null;
  project_id?: string | null;
  kind: CostEventKind;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  compute_ms?: number;
  ref?: string | null;
  // 'platform' = we owe the provider (need to charge); 'byok' = user's
  // own key (informational only). Defaults to 'platform' for callers that
  // haven't been migrated yet — the safe assumption.
  key_source?: KeySource;
}

// Returns the computed amount_usd so callers can log / report it.
export async function recordCost(
  input: RecordCostInput,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<{ amount_usd: number; event_id: string | null }> {
  const amount = computeAmountUsd(input);
  try {
    const { data, error } = await supabase
      .from('cost_events')
      .insert({
        user_id: input.user_id,
        project_id: input.project_id ?? null,
        kind: input.kind,
        model: input.model ?? null,
        input_tokens: input.input_tokens ?? 0,
        output_tokens: input.output_tokens ?? 0,
        compute_ms: input.compute_ms ?? 0,
        amount_usd: amount,
        key_source: input.key_source ?? 'platform',
        ref: input.ref ?? null,
      })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[forge.ledger] insert failed:', error?.message);
      return { amount_usd: amount, event_id: null };
    }
    return { amount_usd: amount, event_id: (data as { id: string }).id };
  } catch (err) {
    // Ledger failures must NEVER blow up the calling path — but they MUST
    // be loud. The guard's fail-closed posture will block the next call
    // if budget calculation can't read the ledger.
    console.error('[forge.ledger] threw:', err);
    return { amount_usd: amount, event_id: null };
  }
}

export function computeAmountUsd(input: RecordCostInput): number {
  switch (input.kind) {
    case 'llm':
      if (!input.model) return 0;
      return llmCostUsd(
        input.model,
        input.input_tokens ?? 0,
        input.output_tokens ?? 0,
      );
    case 'sandbox':
      return sandboxCostUsd(input.compute_ms ?? 0);
    case 'runtime':
      return runtimeCostUsd(input.compute_ms ?? 0);
    default:
      return 0;
  }
}

// Spend for a user inside the current cadence window.
export async function getSpendUsd(
  userId: string,
  period: BudgetPeriod,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<number> {
  const since = periodStart(period);
  const { data, error } = await supabase
    .from('cost_events')
    .select('amount_usd')
    .eq('user_id', userId)
    .gte('created_at', since.toISOString());
  if (error) throw error;
  let sum = 0;
  for (const row of (data ?? []) as Array<{ amount_usd: number | string }>) {
    const n = typeof row.amount_usd === 'string'
      ? Number(row.amount_usd)
      : row.amount_usd;
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

// Total spend for a single project, regardless of period. Used by the agent
// dashboard's "cost-to-date" line.
export async function getProjectSpend(
  projectId: string,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<number> {
  const { data, error } = await supabase
    .from('cost_events')
    .select('amount_usd')
    .eq('project_id', projectId);
  if (error) throw error;
  let sum = 0;
  for (const row of (data ?? []) as Array<{ amount_usd: number | string }>) {
    const n =
      typeof row.amount_usd === 'string'
        ? Number(row.amount_usd)
        : row.amount_usd;
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

// Recent events for the dashboard — kept thin.
export async function getRecentCostEvents(
  userId: string,
  limit = 50,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<CostEvent[]> {
  const { data, error } = await supabase
    .from('cost_events')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CostEvent[];
}

// Boundaries for "daily" and "monthly" use the user's local clock as
// approximated by UTC. Good enough for V1 — refine to per-user TZ later.
export function periodStart(period: BudgetPeriod, at: Date = new Date()): Date {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  if (period === 'monthly') {
    d.setUTCDate(1);
  }
  return d;
}
