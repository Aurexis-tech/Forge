-- Aurexis Forge — sandbox
-- Records each attempt to run a generated build inside an isolated sandbox.
-- The sandbox itself is always destroyed; this table is the only persistent
-- trace of what happened.

create table if not exists public.sandbox_runs (
  id           uuid primary key default gen_random_uuid(),
  build_id     uuid not null references public.builds(id) on delete cascade,
  provider     text not null,
  status       text not null default 'running' check (status in ('running', 'passed', 'failed')),
  build_ok     boolean,
  smoke_ok     boolean,
  logs         jsonb not null default '[]'::jsonb,
  error        text,
  duration_ms  integer,
  iterations   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists sandbox_runs_build_id_idx  on public.sandbox_runs (build_id);
create index if not exists sandbox_runs_status_idx    on public.sandbox_runs (status);
create index if not exists sandbox_runs_created_at_idx on public.sandbox_runs (created_at desc);

-- builds.status during the sandbox phase:
--   'generated'    — codegen complete; ready to test
--   'testing'      — sandbox run in flight
--   'tested'       — sandbox passed (build_ok and smoke_ok)
--   'test_failed'  — sandbox failed; user may refine plan / regenerate code
--
-- The sandbox_runs.logs jsonb stores an array of log lines:
--   [{ phase, stream, message, at }, ...]
-- with the total payload capped server-side so a chatty agent can't blow up
-- the row.
