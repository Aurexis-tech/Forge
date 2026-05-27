-- Aurexis Forge — Phase 3 (Software) — codegen discriminator on the
-- builds table.
--
-- Phase 3 lifts the software gate by one step: a confirmed +
-- approved SoftwareBuildPlan can now reach CODEGEN, producing a
-- Next.js + Supabase application by filling vetted template slots.
-- It still STOPS before app sandbox test, DB provisioning + deploy,
-- and runtime — those layers stay closed for kind='software'.
--
-- The Phase 1 + 2 build paths are untouched. This migration extends
-- the `kind` CHECK on the `builds` table (added in 0018 for systems)
-- to include 'software' alongside 'agent' and 'system'. Existing
-- rows are unaffected — the new constraint is a superset of the
-- previous one.
--
-- RLS: no policy change. `kind` remains discriminator metadata on
-- rows already scoped by builds_owner from 0009_governance.sql.

alter table public.builds
  drop constraint if exists builds_kind_chk;
alter table public.builds
  add constraint builds_kind_chk
    check (kind in ('agent', 'system', 'software'));

-- The builds_kind_idx from 0018 covers the new value without change.
