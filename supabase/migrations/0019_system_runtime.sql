-- Aurexis Forge — Phase 2 (Systems) — runtime discriminator on the
-- agent_runtimes table.
--
-- Phase 2 lifts the system gate the final time: a deployed system can
-- now be ACTIVATED and run end-to-end as a coordinated unit (the
-- orchestrator dispatches each sub-agent module per the DAG). The
-- Phase 1 runtime is reused for sandbox + governance + ledger; only
-- the executor's driver and the scheduler's dispatch differ for
-- kind='system' rows.
--
-- To keep dispatch cheap (the cron tick reads ALL active rows every
-- minute) we add an explicit `kind` column with the same default-'agent'
-- / superset-CHECK pattern used on projects, specs, plans, and builds.
-- Existing rows backfill to 'agent', which keeps every Phase 1 runtime
-- accounted for.
--
-- The `runs` table needs NO discriminator — runs are scoped through
-- runtime_id and inherit the runtime's kind transitively.
--
-- RLS: no policy change. `kind` is discriminator metadata on rows
-- already scoped by agent_runtimes_owner from 0009_governance.sql.

alter table public.agent_runtimes
  add column if not exists kind text not null default 'agent';

alter table public.agent_runtimes
  drop constraint if exists agent_runtimes_kind_chk;
alter table public.agent_runtimes
  add constraint agent_runtimes_kind_chk
    check (kind in ('agent', 'system'));

-- Filtered lookups by kind. The scheduler's tick still reads every
-- active runtime regardless of kind (it dispatches in code), but the
-- per-project loaders and the UI both filter by kind to avoid
-- cross-kind row leakage.
create index if not exists agent_runtimes_kind_idx
  on public.agent_runtimes (kind);
