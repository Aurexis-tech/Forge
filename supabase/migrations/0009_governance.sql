-- Aurexis Forge — governance + per-user isolation
--
-- This migration ships THREE things:
--   1. The cost ledger + budgets + kill switches (governance core)
--   2. user_id columns brought up to UUIDs referencing auth.users
--   3. Row Level Security policies on every user-scoped table so that even
--      if a server route forgets an ownership check, the data layer refuses
--      to leak across users.
--
-- The service role bypasses RLS by design; server route handlers continue
-- to use it for privileged writes. Browser / anon-key reads are constrained
-- by these policies.

-- ---------- governance tables ---------------------------------------------

create table if not exists public.cost_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid,
  project_id     uuid references public.projects(id) on delete set null,
  kind           text not null check (kind in ('llm', 'sandbox', 'runtime')),
  model          text,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  compute_ms     integer not null default 0,
  amount_usd     numeric(12, 6) not null default 0,
  ref            text,
  created_at     timestamptz not null default now()
);

create index if not exists cost_events_user_created_idx
  on public.cost_events (user_id, created_at desc);
create index if not exists cost_events_project_id_idx
  on public.cost_events (project_id);
create index if not exists cost_events_kind_idx
  on public.cost_events (kind);

create table if not exists public.budgets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  period      text not null check (period in ('daily', 'monthly')),
  limit_usd   numeric(12, 2) not null check (limit_usd >= 0),
  hard_cap    boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (user_id, period)
);

create table if not exists public.kill_switches (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null check (scope in ('global', 'user', 'project')),
  -- For scope='global', scope_id is NULL. For 'user' / 'project' it carries
  -- the relevant id (we keep it text so we can store either a UUID or a
  -- user identifier coming from auth.uid()).
  scope_id    text,
  active      boolean not null default true,
  reason      text,
  set_by      text,
  created_at  timestamptz not null default now()
);

create index if not exists kill_switches_active_idx
  on public.kill_switches (active, scope);
create index if not exists kill_switches_scope_scope_id_idx
  on public.kill_switches (scope, scope_id);

-- ---------- migrate user_id columns to uuid where we can ------------------
-- Existing columns are text. Convert in-place when the contents look like a
-- UUID; otherwise leave NULL. New rows will use uuid via Supabase Auth.

alter table public.projects
  alter column user_id type uuid using (case
    when user_id is not null and user_id ~ '^[0-9a-fA-F-]{36}$' then user_id::uuid
    else null
  end);

alter table public.connections
  alter column user_id type uuid using (case
    when user_id is not null and user_id ~ '^[0-9a-fA-F-]{36}$' then user_id::uuid
    else null
  end);

-- ---------- Row Level Security --------------------------------------------
-- Enable RLS on every user-scoped table. The service role bypasses RLS so
-- server code keeps working; anon / authenticated reads are constrained.

alter table public.projects        enable row level security;
alter table public.specs           enable row level security;
alter table public.plans           enable row level security;
alter table public.builds          enable row level security;
alter table public.build_files     enable row level security;
alter table public.connections     enable row level security;
alter table public.deployments     enable row level security;
alter table public.agent_runtimes  enable row level security;
alter table public.runs            enable row level security;
alter table public.sandbox_runs    enable row level security;
alter table public.audit_log       enable row level security;
alter table public.cost_events     enable row level security;
alter table public.budgets         enable row level security;
alter table public.kill_switches   enable row level security;

-- Helper: a project is "yours" if its user_id matches the requester.
-- Inline-checked policies keep the query planner happy.

-- projects: own row
drop policy if exists projects_owner on public.projects;
create policy projects_owner on public.projects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- specs / plans / builds / build_files / sandbox_runs / deployments /
-- audit_log: scoped via projects.user_id
drop policy if exists specs_owner on public.specs;
create policy specs_owner on public.specs
  for all using (exists (
    select 1 from public.projects p where p.id = specs.project_id and p.user_id = auth.uid()
  ));

drop policy if exists plans_owner on public.plans;
create policy plans_owner on public.plans
  for all using (exists (
    select 1 from public.projects p where p.id = plans.project_id and p.user_id = auth.uid()
  ));

drop policy if exists builds_owner on public.builds;
create policy builds_owner on public.builds
  for all using (exists (
    select 1 from public.projects p where p.id = builds.project_id and p.user_id = auth.uid()
  ));

drop policy if exists build_files_owner on public.build_files;
create policy build_files_owner on public.build_files
  for all using (exists (
    select 1 from public.builds b
    join public.projects p on p.id = b.project_id
    where b.id = build_files.build_id and p.user_id = auth.uid()
  ));

drop policy if exists sandbox_runs_owner on public.sandbox_runs;
create policy sandbox_runs_owner on public.sandbox_runs
  for all using (exists (
    select 1 from public.builds b
    join public.projects p on p.id = b.project_id
    where b.id = sandbox_runs.build_id and p.user_id = auth.uid()
  ));

drop policy if exists deployments_owner on public.deployments;
create policy deployments_owner on public.deployments
  for all using (exists (
    select 1 from public.builds b
    join public.projects p on p.id = b.project_id
    where b.id = deployments.build_id and p.user_id = auth.uid()
  ));

drop policy if exists audit_log_owner on public.audit_log;
create policy audit_log_owner on public.audit_log
  for select using (
    project_id is null
    or exists (
      select 1 from public.projects p where p.id = audit_log.project_id and p.user_id = auth.uid()
    )
  );

-- agent_runtimes / runs: same scoping via project ownership
drop policy if exists agent_runtimes_owner on public.agent_runtimes;
create policy agent_runtimes_owner on public.agent_runtimes
  for all using (exists (
    select 1 from public.projects p where p.id = agent_runtimes.project_id and p.user_id = auth.uid()
  ));

drop policy if exists runs_owner on public.runs;
create policy runs_owner on public.runs
  for all using (exists (
    select 1 from public.agent_runtimes r
    join public.projects p on p.id = r.project_id
    where r.id = runs.runtime_id and p.user_id = auth.uid()
  ));

-- connections / cost_events / budgets: by user_id directly
drop policy if exists connections_owner on public.connections;
create policy connections_owner on public.connections
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists cost_events_owner on public.cost_events;
create policy cost_events_owner on public.cost_events
  for select using (user_id = auth.uid());

drop policy if exists budgets_owner on public.budgets;
create policy budgets_owner on public.budgets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- kill_switches: a user can see global switches + their own + ones on
-- projects they own. Setting them is server-only.
drop policy if exists kill_switches_read on public.kill_switches;
create policy kill_switches_read on public.kill_switches
  for select using (
    scope = 'global'
    or (scope = 'user' and scope_id = auth.uid()::text)
    or (
      scope = 'project'
      and exists (
        select 1 from public.projects p
        where p.id::text = kill_switches.scope_id and p.user_id = auth.uid()
      )
    )
  );

-- Status check note: builds.status now also takes 'budget_paused' through a
-- runtime that hit the cap, but we don't constrain status with a CHECK
-- anywhere so no schema change is needed there.
