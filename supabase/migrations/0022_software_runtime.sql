-- Aurexis Forge — Phase 3-6 (Software) — extend the agent_runtimes
-- kind discriminator to include 'software'.
--
-- Phase 3-6 closes the software mold: a deployed app can now be
-- marked LIVE behind an authorisation gate. Because a deployed
-- full-stack app is already serving at its Vercel URL, the "runtime"
-- for software is lighter than the agent/system executor:
--
--   - The agent_runtimes row exists ONLY to mark the app live (and
--     to give the kill switch a place to flip status → 'paused' when
--     the budget/kill ceiling fires).
--   - mode is always 'always_on' (the app is continuously reachable
--     at its URL — there is no scheduled tick).
--   - schedule_cron carries a non-null placeholder ('@always') so the
--     existing NOT NULL constraint stays honoured without inventing a
--     special-case 'never' cron.
--   - next_run_at stays NULL — the shared scheduler picks rows by
--     `.lte('next_run_at', now)` and so will skip every software row
--     by default. The scheduler also early-returns in runOnce when
--     the dispatch sees kind='software' (defence in depth).
--
-- The runs table needs NO discriminator change — software runtimes
-- DO NOT spawn runs. (The kill-switch flip itself doesn't create a
-- runs row.)
--
-- RLS: no policy change. `kind` is discriminator metadata on rows
-- already scoped by agent_runtimes_owner from 0009_governance.sql.

alter table public.agent_runtimes
  drop constraint if exists agent_runtimes_kind_chk;
alter table public.agent_runtimes
  add constraint agent_runtimes_kind_chk
    check (kind in ('agent', 'system', 'software'));

-- builds.status during the software runtime phase:
--   'deployed' — app deployed, runtime not yet activated
--   'running'  — a software agent_runtimes row exists in active /
--                paused / errored state (the app is "live" — or
--                temporarily offline because the kill switch fired)
--   On stop, the runtime row is marked 'stopped' and builds.status
--   returns to 'deployed' so the user can re-activate via the gate.
