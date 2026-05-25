-- Aurexis Forge — initial schema
-- Foundation tables for projects, specs, builds, and audit logging.

create extension if not exists "pgcrypto";

-- Projects: a single user-facing AI product being forged.
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     text,
  name        text not null,
  status      text not null default 'draft',
  created_at  timestamptz not null default now()
);

create index if not exists projects_created_at_idx
  on public.projects (created_at desc);

-- Specs: the structured (or yet-to-be-structured) intent for a project.
create table if not exists public.specs (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  raw_prompt      text not null,
  structured_spec jsonb,
  status          text not null default 'pending',
  created_at      timestamptz not null default now()
);

create index if not exists specs_project_id_idx
  on public.specs (project_id);

-- Builds: a single build/run attempt for a project + spec.
create table if not exists public.builds (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  spec_id     uuid references public.specs(id) on delete set null,
  phase       text,
  status      text not null default 'queued',
  logs        jsonb not null default '[]'::jsonb,
  repo_url    text,
  deploy_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists builds_project_id_idx
  on public.builds (project_id);

-- Audit log: append-only record of meaningful state changes.
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete set null,
  action      text not null,
  actor       text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_project_id_idx
  on public.audit_log (project_id);
create index if not exists audit_log_created_at_idx
  on public.audit_log (created_at desc);

-- Keep builds.updated_at fresh on row updates.
create or replace function public.touch_builds_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists builds_set_updated_at on public.builds;
create trigger builds_set_updated_at
  before update on public.builds
  for each row execute function public.touch_builds_updated_at();
