-- Aurexis Forge — prepaid TOKEN WALLET (platform-billing backbone).
--
-- A per-user balance denominated in TOKENS. This is the single meter for the
-- whole platform, sized for real AI-infrastructure builds — not just chat:
--   - LLM calls debit their real token count (input + output + cache) 1:1.
--   - Sandbox / runtime / infra cost (naturally priced in USD) converts into
--     the SAME token unit at the platform reference rate (see
--     lib/engine/governance/pricing.ts → usdToTokens). One balance, one unit.
--
-- Only PLATFORM-key usage debits the wallet. BYOK users pay their provider
-- directly and never touch it (consistent with the budget-cap skip).
--
-- Mutations are ATOMIC + RACE-SAFE via apply_token_delta(): a parallel build
-- firing many LLM + sandbox calls at once cannot oversell the balance.
-- Every mutation writes ONE token_ledger row carrying the post-mutation
-- balance, so the ledger is a complete, auditable history.
--
-- RLS: owners can READ their wallet + ledger. Writes happen only through the
-- service role calling apply_token_delta (execute granted to service_role
-- only; revoked from anon/authenticated).

-- ---------- wallet + ledger ------------------------------------------------

create table if not exists public.token_wallets (
  user_id            uuid primary key,
  balance_tokens     bigint not null default 0,
  lifetime_granted   bigint not null default 0,
  lifetime_spent     bigint not null default 0,
  -- below this, the dashboard nudges a top-up. Tunable per user later.
  low_balance_tokens bigint not null default 100000,
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create table if not exists public.token_ledger (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  -- positive = credit (top-up / grant / refund), negative = debit (usage).
  delta_tokens   bigint not null,
  -- the wallet balance AFTER this entry was applied (audit-grade history).
  balance_after  bigint not null,
  entry_kind     text not null
    check (entry_kind in ('topup', 'grant', 'debit', 'refund', 'adjustment')),
  -- what drove it. 'llm'|'sandbox'|'runtime'|'infra' for usage debits;
  -- 'manual'|'promo'|'payment' for credits; 'adjustment' for corrections.
  source         text not null default 'manual'
    check (source in ('llm', 'sandbox', 'runtime', 'infra', 'manual', 'promo', 'payment', 'adjustment')),
  project_id     uuid references public.projects(id) on delete set null,
  cost_event_id  uuid references public.cost_events(id) on delete set null,
  ref            text,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists token_ledger_user_created_idx
  on public.token_ledger (user_id, created_at desc);
create index if not exists token_ledger_cost_event_idx
  on public.token_ledger (cost_event_id);
create index if not exists token_ledger_project_idx
  on public.token_ledger (project_id);

-- ---------- atomic balance mutation ----------------------------------------
-- Locks the wallet row (creating a zero wallet on first touch), applies the
-- signed delta, writes the ledger row, returns the new balance. SECURITY
-- DEFINER so it runs with the migration owner's rights; execute is granted
-- ONLY to service_role. A debit may drive the balance slightly negative if a
-- single call's real usage overshoots its pre-call estimate — that is
-- intentional (honest accounting); the guard blocks the NEXT call.

create or replace function public.apply_token_delta(
  p_user        uuid,
  p_delta       bigint,
  p_entry_kind  text,
  p_source      text default 'manual',
  p_project     uuid default null,
  p_cost_event  uuid default null,
  p_ref         text default null,
  p_metadata    jsonb default '{}'::jsonb
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
begin
  insert into public.token_wallets (user_id)
    values (p_user)
    on conflict (user_id) do nothing;

  -- serialise concurrent debits/credits for this user
  select balance_tokens into v_balance
    from public.token_wallets
    where user_id = p_user
    for update;

  v_balance := v_balance + p_delta;

  update public.token_wallets
     set balance_tokens   = v_balance,
         lifetime_granted = lifetime_granted + (case when p_delta > 0 then p_delta else 0 end),
         lifetime_spent   = lifetime_spent   + (case when p_delta < 0 then -p_delta else 0 end),
         updated_at       = now()
   where user_id = p_user;

  insert into public.token_ledger
    (user_id, delta_tokens, balance_after, entry_kind, source,
     project_id, cost_event_id, ref, metadata)
  values
    (p_user, p_delta, v_balance, p_entry_kind, coalesce(p_source, 'manual'),
     p_project, p_cost_event, p_ref, coalesce(p_metadata, '{}'::jsonb));

  return v_balance;
end;
$$;

-- ---------- RLS ------------------------------------------------------------

alter table public.token_wallets enable row level security;
alter table public.token_ledger  enable row level security;

drop policy if exists token_wallets_owner on public.token_wallets;
create policy token_wallets_owner on public.token_wallets
  for select using (user_id = auth.uid());

drop policy if exists token_ledger_owner on public.token_ledger;
create policy token_ledger_owner on public.token_ledger
  for select using (user_id = auth.uid());

-- Only the service role may mutate balances (through the function).
revoke all on function public.apply_token_delta(uuid, bigint, text, text, uuid, uuid, text, jsonb) from public;
grant execute on function public.apply_token_delta(uuid, bigint, text, text, uuid, uuid, text, jsonb) to service_role;
