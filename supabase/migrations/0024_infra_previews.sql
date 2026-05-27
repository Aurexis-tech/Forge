-- Aurexis Forge — Phase 4-4 (Infrastructure) PREVIEW + COST CEILING.
--
-- Phase 4-4 lifts the infrastructure gate one step further: a
-- 'generated' infra build can now render a human-readable PREVIEW of
-- what would be created + a COST ESTIMATE, and the COST CEILING acts
-- as a forward-action GATE — the one place in the engine where the
-- budget cap blocks a future action based on PROJECTED cost. It still
-- STOPS before provision/apply (P4-5) and runtime (P4-6).
--
-- The preview is INERT: derived deterministically from the composed
-- IaC + the catalog. No terraform plan, no cloud API call, no
-- credentials needed. The real plan against live cloud state runs
-- inside the P4-5 typed-confirm gate, dead last.
--
-- RLS: project-owner-scoped, same shape as software_databases.

create table if not exists public.infra_previews (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references public.projects(id) on delete cascade,
  build_id                 uuid not null references public.builds(id)   on delete cascade,

  -- Aggregated cost figures (rounded to cents). Surfaced verbatim in
  -- the UI banner + the audit log; recomputable from the preview blob.
  estimated_usd_per_month  numeric(12,2) not null,
  estimated_usd_per_hour   numeric(12,4) not null,

  -- Ceiling check outcome — 'within_budget', 'over_budget', or
  -- 'no_budget_set' (no hard-cap budget configured).
  ceiling_verdict          text not null check (ceiling_verdict in (
    'within_budget',
    'over_budget',
    'no_budget_set'
  )),
  -- Period the binding cap was set against ('monthly' / 'daily') or
  -- null when no cap applies.
  ceiling_period           text check (ceiling_period in ('monthly', 'daily')),
  ceiling_limit_usd        numeric(12,2),
  -- Cost projected against the binding window (e.g. for a daily cap,
  -- the per-day figure derived from the monthly estimate). Null when
  -- no cap applies.
  ceiling_projected_usd    numeric(12,4),

  -- The full preview payload: per-layer steps + per-module breakdown +
  -- public-exposure opt-ins. Same shape as InfraPreviewResult in
  -- lib/engine/infra/preview/derive.ts; the route writes it once and
  -- the UI reads it on every project page load.
  preview                  jsonb not null,
  -- Persisted message from the ceiling check — surfaced verbatim in
  -- the UI banner so the verdict reads consistently across the app.
  ceiling_message          text not null,

  created_at               timestamptz not null default now()
);

create index if not exists infra_previews_project_id_idx
  on public.infra_previews (project_id);
create index if not exists infra_previews_build_id_idx
  on public.infra_previews (build_id);

-- RLS: owner-scoped via the project. Mirror the policy shape from
-- software_databases / sandbox_runs.

alter table public.infra_previews enable row level security;

drop policy if exists infra_previews_owner on public.infra_previews;
create policy infra_previews_owner on public.infra_previews
  for all
  using (
    exists (
      select 1
      from public.projects p
      where p.id = infra_previews.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      where p.id = infra_previews.project_id and p.user_id = auth.uid()
    )
  );

-- builds.status during the infrastructure preview phase:
--   'generated'        — codegen finished (P4-3); ready for preview
--   'previewing'       — preview derivation in flight
--   'previewed'        — preview rendered + ceiling within budget;
--                        provisioning is UNLOCKED (still gated by
--                        the P4-5 typed confirm)
--   'preview_blocked'  — preview rendered + ceiling OVER budget;
--                        provisioning STAYS LOCKED; user must raise
--                        the cap or trim the spec
--
-- The build_status text column has no CHECK constraint (free-form
-- string in 0001_init.sql) so these values land without a migration
-- to the constraint itself. lib/types.ts BuildStatus union is
-- extended alongside this migration to include the new states.
