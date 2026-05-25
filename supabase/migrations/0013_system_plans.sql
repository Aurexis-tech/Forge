-- Aurexis Forge — Phase 2 (Systems) — orchestration plan discriminator
--
-- Mirrors 0012_systems.sql. Adds a `kind` column to the `plans` table so
-- the same plans table can hold EITHER a Phase 1 BuildPlan (kind='agent')
-- OR a Phase 2 OrchestrationPlan (kind='system'). The discriminator
-- tells the engine which Zod schema to validate against on read.
--
-- All existing rows default to 'agent' — the Phase 1 planner flow is
-- unaffected. RLS is unchanged; existing plans_owner policy in
-- 0009_governance.sql already scopes per project ownership and `kind`
-- is just discriminator metadata on protected rows.

alter table public.plans
  add column if not exists kind text not null default 'agent';
alter table public.plans
  drop constraint if exists plans_kind_chk;
alter table public.plans
  add constraint plans_kind_chk check (kind in ('agent', 'system'));

create index if not exists plans_kind_idx on public.plans (kind);
