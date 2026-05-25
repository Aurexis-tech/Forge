-- Aurexis Forge — multi-currency display for budgets.
--
-- CRITICAL: limit_usd remains the canonical, ENFORCED value. The guard
-- ('lib/engine/governance/guard.ts') still compares spend (in USD) to
-- limit_usd. The display_currency is for DATA ENTRY + UI DISPLAY only and
-- is converted to USD at SAVE TIME via lib/fx.ts. Enforcement never
-- depends on live FX.

alter table public.budgets
  add column if not exists display_currency text not null default 'USD';

-- ISO 4217 alpha codes only; the app validates against the known list in
-- lib/currencies.ts so a typo can't slip through. Keep this as a CHECK
-- rather than an enum so adding a currency is a code-only change.
alter table public.budgets
  drop constraint if exists budgets_display_currency_format;
alter table public.budgets
  add constraint budgets_display_currency_format
  check (display_currency ~ '^[A-Z]{3}$');
