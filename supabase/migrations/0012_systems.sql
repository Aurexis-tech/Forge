-- Aurexis Forge — Phase 2 (Systems) — additive discriminator
--
-- Introduces a `kind` column on both projects and specs so the existing
-- spec table can hold EITHER an AgentSpec (Phase 1) or a SystemSpec
-- (Phase 2) payload in `structured_spec`. The discriminator tells the
-- engine which Zod schema to validate against.
--
-- All existing rows default to 'agent', so the Phase 1 flow is
-- completely unaffected. Only when the intake classifier (or a manual
-- override) labels a project as 'system' does the new code path engage.
--
-- RLS: no policy change. `kind` is metadata on rows already protected by
-- the ownership policies in 0009_governance.sql (projects_owner /
-- specs_owner). The service role bypasses RLS as before for server
-- writes.

alter table public.projects
  add column if not exists kind text not null default 'agent';
alter table public.projects
  drop constraint if exists projects_kind_chk;
alter table public.projects
  add constraint projects_kind_chk check (kind in ('agent', 'system'));

alter table public.specs
  add column if not exists kind text not null default 'agent';
alter table public.specs
  drop constraint if exists specs_kind_chk;
alter table public.specs
  add constraint specs_kind_chk check (kind in ('agent', 'system'));

create index if not exists projects_kind_idx on public.projects (kind);
create index if not exists specs_kind_idx on public.specs (kind);
