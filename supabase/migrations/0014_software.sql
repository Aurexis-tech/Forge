-- Aurexis Forge — Phase 3 (Software) — third mold on the existing engine.
--
-- Extends the `kind` discriminator on projects + specs to include
-- 'software' alongside the existing 'agent' (Phase 1) and 'system'
-- (Phase 2). DEFAULT stays 'agent', so every existing row is
-- unaffected. Phase 3 is INTAKE-ONLY in this prompt: schema +
-- classifier + extractor + review gate. Code generation, sandbox,
-- deploy, runtime are explicitly NOT extended; the planner loaders
-- 409 a confirmed software spec at the boundary.
--
-- RLS: no policy change. `kind` remains discriminator metadata on
-- rows already scoped by projects_owner / specs_owner from
-- 0009_governance.sql.

alter table public.projects
  drop constraint if exists projects_kind_chk;
alter table public.projects
  add constraint projects_kind_chk check (kind in ('agent', 'system', 'software'));

alter table public.specs
  drop constraint if exists specs_kind_chk;
alter table public.specs
  add constraint specs_kind_chk check (kind in ('agent', 'system', 'software'));

-- The existing indexes from 0012_systems.sql (`projects_kind_idx`,
-- `specs_kind_idx`) cover the new value without change.
