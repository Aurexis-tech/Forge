-- Aurexis Forge — Phase 3 (Software) — plan discriminator extension.
--
-- Mirrors 0013_system_plans.sql. Extends the `kind` CHECK on the
-- `plans` table to include 'software' alongside 'agent' (Phase 1) and
-- 'system' (Phase 2). DEFAULT stays 'agent'. Existing rows are
-- unaffected — the new constraint is a superset of the old one.
--
-- RLS unchanged; the plans_owner policy from 0009_governance.sql
-- already scopes per-project ownership and `kind` is just
-- discriminator metadata on protected rows.

alter table public.plans
  drop constraint if exists plans_kind_chk;
alter table public.plans
  add constraint plans_kind_chk check (kind in ('agent', 'system', 'software'));

-- The existing plans_kind_idx from 0013_system_plans.sql covers the
-- new value without change.
