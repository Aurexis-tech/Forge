-- Aurexis Forge — Phase 4 (Infrastructure) — fourth and final mold.
--
-- Extends the `kind` discriminator on projects + specs to include
-- 'infrastructure' alongside 'agent' (Phase 1), 'system' (Phase 2),
-- and 'software' (Phase 3). DEFAULT stays 'agent', so every existing
-- row is unaffected. Phase 4 is INTAKE-ONLY in this prompt: schema +
-- classifier extension + extractor + persistence + review gate.
-- Generation, preview, provisioning are explicitly NOT extended — all
-- three sibling planner loaders 409 a confirmed infrastructure spec at
-- the boundary as defence-in-depth for direct API callers.
--
-- RLS: no policy change. `kind` remains discriminator metadata on rows
-- already scoped by projects_owner / specs_owner from
-- 0009_governance.sql.

alter table public.projects
  drop constraint if exists projects_kind_chk;
alter table public.projects
  add constraint projects_kind_chk check (kind in ('agent', 'system', 'software', 'infrastructure'));

alter table public.specs
  drop constraint if exists specs_kind_chk;
alter table public.specs
  add constraint specs_kind_chk check (kind in ('agent', 'system', 'software', 'infrastructure'));

-- The existing indexes (`projects_kind_idx`, `specs_kind_idx` from
-- 0012_systems.sql) cover the new value without change.
