-- Aurexis Forge — runtime (always_on / scheduled agents)
--
-- V1 model: cron-driven PERIODIC execution. Each tick spins up a fresh
-- isolated sandbox, runs one execution in LIVE mode, captures the result,
-- and destroys the sandbox. Truly persistent long-lived processes are
-- a documented future enhancement.

create table if not exists public.agent_runtimes (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  build_id           uuid not null references public.builds(id) on delete cascade,
  mode               text not null check (mode in ('schedule', 'always_on')),
  schedule_cron      text not null,
  status             text not null default 'active' check (status in ('active', 'paused', 'stopped', 'errored')),
  next_run_at        timestamptz,
  last_run_at        timestamptz,
  run_count          integer not null default 0,
  fail_count         integer not null default 0,
  consecutive_fails  integer not null default 0,
  max_run_ms         integer not null default 60000,
  -- AES-256-GCM ciphertext of a JSON object { key: value, ... } holding the
  -- real (potentially secret) env vars injected into each run. Plaintext
  -- never persisted anywhere else.
  env_encrypted      text,
  -- Public list of declared env keys for display + audit (NOT values).
  env_keys           text[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists agent_runtimes_status_idx       on public.agent_runtimes (status);
create index if not exists agent_runtimes_next_run_at_idx  on public.agent_runtimes (next_run_at);
create index if not exists agent_runtimes_project_id_idx   on public.agent_runtimes (project_id);

create or replace function public.touch_agent_runtimes_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists agent_runtimes_set_updated_at on public.agent_runtimes;
create trigger agent_runtimes_set_updated_at
  before update on public.agent_runtimes
  for each row execute function public.touch_agent_runtimes_updated_at();

create table if not exists public.runs (
  id           uuid primary key default gen_random_uuid(),
  runtime_id   uuid not null references public.agent_runtimes(id) on delete cascade,
  trigger      text not null check (trigger in ('tick', 'manual')),
  status       text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  duration_ms  integer,
  logs         jsonb not null default '[]'::jsonb,
  output       jsonb,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists runs_runtime_id_idx  on public.runs (runtime_id);
create index if not exists runs_status_idx      on public.runs (status);
create index if not exists runs_created_at_idx  on public.runs (created_at desc);

-- builds.status during the runtime phase:
--   'pushed'   — runtime not yet activated
--   'running'  — an agent_runtimes row exists in active / paused / errored
--                state (the build has an active 24/7 runtime)
--   On stop, the runtime row is marked 'stopped' and builds.status returns
--   to 'pushed' so the user can activate again.
