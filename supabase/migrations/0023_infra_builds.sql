-- Aurexis Forge — Phase 4 (Infrastructure) — codegen discriminator on
-- the builds table.
--
-- Phase 4 lifts the infrastructure gate by ONE step: an approved
-- ProvisioningPlan can now reach IaC GENERATION, producing Terraform
-- files by COMPOSING the closed module catalog (lib/engine/infra/
-- planner/modules.ts). It still STOPS before preview (P4-4),
-- provision/apply (P4-5), and runtime (P4-6) — those layers stay
-- closed for kind='infrastructure'.
--
-- The non-negotiables baked in STRUCTURALLY by the generator (not by
-- prompting):
--   1. COMPOSED FROM VETTED MODULES ONLY — every generated resource
--      traces to a catalog module; no freehand IaC code path exists.
--   2. SECURE DEFAULTS — private-by-default networking, TLS, least-
--      privilege IAM, KMS encryption — all baked into the modules.
--   3. NOTHING IS APPLIED — generation produces code + a STATIC parse
--      check only; no `terraform plan`, no `terraform apply`, no
--      cloud API call. Apply (P4-5) is dead last, behind a typed
--      destructive-confirm gate.
--
-- The Phases 1/2/3 build paths are untouched. This migration extends
-- the `kind` CHECK on the `builds` table (added in 0018 for systems,
-- extended in 0020 for software) to include 'infrastructure'.
-- Existing rows are unaffected — the new constraint is a superset of
-- the previous one.
--
-- RLS: no policy change. `kind` remains discriminator metadata on
-- rows already scoped by builds_owner from 0009_governance.sql.

alter table public.builds
  drop constraint if exists builds_kind_chk;
alter table public.builds
  add constraint builds_kind_chk
    check (kind in ('agent', 'system', 'software', 'infrastructure'));

-- The builds_kind_idx from 0018 covers the new value without change.
