-- Aurexis Forge — Phase 2 (Systems) — codegen discriminator on the
-- builds table.
--
-- Phase 2 lifts the system gate by one step: a confirmed + approved
-- SystemSpec can now reach CODEGEN, producing an orchestrator file
-- plus one module per sub-agent (the latter via the reused Phase 1
-- agent generator). It still STOPS before sandbox test, deploy, and
-- runtime — those layers stay closed for kind='system'.
--
-- The Phase 1 build path is untouched. To tell apart agent vs system
-- build rows on the same `builds` table we add a `kind` column with
-- the same default-'agent' / superset-CHECK pattern used on the
-- projects, specs, and plans tables. Existing rows backfill to
-- 'agent', which keeps every Phase 1 build accounted for.
--
-- RLS: no policy change. `kind` is discriminator metadata on rows
-- already scoped by builds_owner from 0009_governance.sql.

alter table public.builds
  add column if not exists kind text not null default 'agent';

-- Backfill is implicit (default 'agent'); the CHECK is a superset
-- of the previous (no-CHECK) state so no row can violate it.
alter table public.builds
  drop constraint if exists builds_kind_chk;
alter table public.builds
  add constraint builds_kind_chk
    check (kind in ('agent', 'system'));

-- Filtered lookups by kind (the system build route uses
-- `loadLatestSystemBuild` which scopes to kind='system'; the agent
-- build path keeps reading the latest row regardless of kind, which
-- still resolves to an agent row because system rows never appear on
-- agent projects).
create index if not exists builds_kind_idx
  on public.builds (kind);
