// The TOKEN WALLET — the platform-billing backbone.
//
// A per-user prepaid balance in TOKENS. Every PLATFORM-key cost event debits
// it; BYOK never touches it. All mutations go through the atomic SQL function
// `apply_token_delta` (migration 0030) so concurrent debits during a parallel
// build can never oversell the balance.
//
// Reads are RLS-scoped per user. Writes use the service role (the only role
// granted EXECUTE on apply_token_delta).
//
// Decoupled from llm.ts on purpose (ledger.ts → wallet.ts; llm.ts → ledger.ts)
// — never import the LLM layer here or you create a cycle.

import { getServerSupabase, type ForgeSupabase } from '@/lib/supabase';
import { engineLog } from '../log';
import { usdToTokens } from './pricing';
import type {
  CostEventKind,
  TokenEntryKind,
  TokenLedgerEntry,
  TokenSource,
  TokenWallet,
} from '@/lib/types';

const log = engineLog('wallet');

// Master switch. When platform billing is on (REQUIRE_BYOK=false), the wallet
// gates + meters platform usage. Default ON so flipping REQUIRE_BYOK can never
// silently open an unmetered platform-spend path. Set ENFORCE_TOKEN_WALLET=
// false to disable enforcement (the ledger still records).
export function isWalletEnforced(): boolean {
  const raw = (process.env.ENFORCE_TOKEN_WALLET ?? 'true').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

export interface ApplyDeltaInput {
  user_id: string;
  delta_tokens: number; // signed: + credit, - debit
  entry_kind: TokenEntryKind;
  source?: TokenSource;
  project_id?: string | null;
  cost_event_id?: string | null;
  ref?: string | null;
  metadata?: Record<string, unknown>;
}

// Atomic, race-safe. Returns the new balance, or null on failure (logged,
// never thrown — a wallet write must NOT blow up the calling cost path; the
// guard fails closed on the next call if the balance ends up wrong).
export async function applyDelta(
  input: ApplyDeltaInput,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc('apply_token_delta', {
      p_user: input.user_id,
      p_delta: Math.trunc(input.delta_tokens),
      p_entry_kind: input.entry_kind,
      p_source: input.source ?? 'manual',
      p_project: input.project_id ?? null,
      p_cost_event: input.cost_event_id ?? null,
      p_ref: input.ref ?? null,
      p_metadata: input.metadata ?? {},
    });
    if (error) {
      log.error('apply_token_delta failed', { error: error.message });
      return null;
    }
    return typeof data === 'string' ? Number(data) : (data as number);
  } catch (err) {
    log.error('apply_token_delta threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getWallet(
  userId: string,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<TokenWallet | null> {
  const { data, error } = await supabase
    .from('token_wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    log.error('wallet read failed', { error: error.message });
    return null;
  }
  return (data as TokenWallet | null) ?? null;
}

export async function getBalance(
  userId: string,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<number> {
  const w = await getWallet(userId, supabase);
  return w?.balance_tokens ?? 0;
}

export interface TopUpOptions {
  source?: TokenSource; // 'manual' (default) | 'payment' | 'promo'
  ref?: string | null;
  metadata?: Record<string, unknown>;
}

// Add tokens to a wallet. The SINGLE credit path — the instant manual top-up
// route calls this today; a verified Razorpay/Stripe webhook will call the
// exact same function (with source='payment') tomorrow.
export async function topUp(
  userId: string,
  tokens: number,
  opts: TopUpOptions = {},
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<number | null> {
  const amount = Math.max(0, Math.trunc(tokens));
  if (amount <= 0) return getBalance(userId, supabase);
  const entry_kind: TokenEntryKind = opts.source === 'promo' ? 'grant' : 'topup';
  return applyDelta(
    {
      user_id: userId,
      delta_tokens: amount,
      entry_kind,
      source: opts.source ?? 'manual',
      ref: opts.ref ?? null,
      metadata: opts.metadata,
    },
    supabase,
  );
}

export interface CostDebitInput {
  user_id: string;
  kind: CostEventKind | string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  amount_usd?: number;
  project_id?: string | null;
  cost_event_id?: string | null;
  ref?: string | null;
}

// Tokens to debit for one platform cost event. LLM → real token sum
// (input + output + both cache buckets). Everything else → USD converted to
// the token unit so compute + infra share the same meter.
export function tokensForCostEvent(input: CostDebitInput): number {
  if (input.kind === 'llm') {
    return (
      (input.input_tokens ?? 0) +
      (input.output_tokens ?? 0) +
      (input.cache_creation_input_tokens ?? 0) +
      (input.cache_read_input_tokens ?? 0)
    );
  }
  return usdToTokens(input.amount_usd ?? 0);
}

// Debit the wallet for a recorded platform cost event. Best-effort: returns
// the new balance, or null if nothing was debited / the write failed.
export async function debitForCostEvent(
  input: CostDebitInput,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<number | null> {
  const tokens = tokensForCostEvent(input);
  if (tokens <= 0) return null;
  const source: TokenSource =
    input.kind === 'llm' ||
    input.kind === 'sandbox' ||
    input.kind === 'runtime' ||
    input.kind === 'infra'
      ? (input.kind as TokenSource)
      : 'adjustment';
  return applyDelta(
    {
      user_id: input.user_id,
      delta_tokens: -tokens,
      entry_kind: 'debit',
      source,
      project_id: input.project_id ?? null,
      cost_event_id: input.cost_event_id ?? null,
      ref: input.ref ?? null,
    },
    supabase,
  );
}

export async function getRecentLedger(
  userId: string,
  limit = 50,
  supabase: ForgeSupabase = getServerSupabase(),
): Promise<TokenLedgerEntry[]> {
  const { data, error } = await supabase
    .from('token_ledger')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    log.error('ledger read failed', { error: error.message });
    return [];
  }
  return (data ?? []) as TokenLedgerEntry[];
}
