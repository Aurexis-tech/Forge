-- Aurexis Forge — codegen
-- Links builds to the approved plan they came from, and introduces a
-- per-file table for storing the generated agent's source.

alter table public.builds
  add column if not exists plan_id uuid references public.plans(id) on delete set null;

create index if not exists builds_plan_id_idx on public.builds (plan_id);

-- One row per file in the agent project. Source is either 'scaffold'
-- (materialised deterministically from the codegen scaffold templates) or
-- 'generated' (produced by the LLM and then parsed with esbuild — never
-- executed at this layer).
create table if not exists public.build_files (
  id          uuid primary key default gen_random_uuid(),
  build_id    uuid not null references public.builds(id) on delete cascade,
  path        text not null,
  content     text not null,
  source      text not null check (source in ('scaffold', 'generated')),
  bytes       integer not null,
  created_at  timestamptz not null default now(),
  unique (build_id, path)
);

create index if not exists build_files_build_id_idx on public.build_files (build_id);

-- builds.status during the codegen phase:
--   'queued'      — row inserted, work not yet started
--   'generating'  — scaffold + LLM generation in flight
--   'generated'   — file set complete and stored
--   'failed'      — codegen errored; user may retry
--
-- builds.logs (jsonb) carries per-file static-check results during codegen:
--   { static_checks: [{ path, status: 'ok'|'failed'|'skipped', error? }, ...],
--     warnings: [string, ...] }
