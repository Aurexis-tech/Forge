-- Aurexis Forge — planner
-- Adds the `plans` table. One project can have many plans over time, but only
-- the most recent one is rendered. Like `specs`, the row carries feedback so
-- the user can refine the plan without losing history.

create table if not exists public.plans (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  spec_id     uuid not null references public.specs(id) on delete cascade,
  plan        jsonb,
  status      text not null default 'pending',
  feedback    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists plans_project_id_idx on public.plans (project_id);
create index if not exists plans_status_idx     on public.plans (status);

-- plans.status state machine:
--   'pending'         — row exists, no planning attempt yet
--   'planning'        — LLM call in flight
--   'awaiting_review' — plan saved, awaiting user approve/refine
--   'approved'        — plan locked; codegen may consume it
--   'failed'          — planning errored; user may retry
