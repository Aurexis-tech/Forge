-- Aurexis Forge — Phase 4-6 (Infrastructure) MONITORING + DRIFT.
--
-- Provisioned infrastructure is standing in the cloud accruing real
-- cost. "Runtime" for infra is ongoing monitoring (not a scheduled
-- executor): resource status + accruing cost vs the budget cap +
-- DRIFT detection (read-only re-run of `terraform plan` to spot
-- divergence between the IaC and the actual cloud state).
--
-- Drift checks are inert — same boundary as P4-5a's plan: read-only
-- against cloud state, NO apply, NO write. The CloudProvider's
-- plan() method is reused unchanged; the route classifies the diff
-- as in-sync vs drifted and persists the verdict here.
--
-- RLS: project-owner-scoped, mirror infra_previews / infra_plans /
-- infra_applies.

create table if not exists public.infra_drift_checks (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references public.projects(id) on delete cascade,
  build_id                 uuid not null references public.builds(id)   on delete cascade,
  apply_id                 uuid not null references public.infra_applies(id) on delete cascade,

  -- in_sync  → no changes detected. Live cloud matches the IaC.
  -- drifted  → terraform plan would CREATE / CHANGE / DESTROY at
  --            least one resource against current cloud state.
  -- failed   → the drift check itself errored (e.g. cloud credentials
  --            rotated). The dashboard surfaces "unknown" rather
  --            than guessing.
  verdict                  text not null check (verdict in (
    'in_sync',
    'drifted',
    'failed'
  )),

  -- Counts derived from the plan diff. Denormalised for fast UI
  -- rendering; the full sanitised diff lives in `diff_summary`.
  create_count             integer not null default 0,
  change_count             integer not null default 0,
  destroy_count            integer not null default 0,

  -- Sanitised plan diff — same shape the CloudProvider returns from
  -- plan(), boundary-sanitised so no secret-shaped string can land
  -- here. Optional (null when the drift check itself failed).
  diff_summary             jsonb,

  -- Error message when verdict='failed'. NEVER carries raw cloud
  -- creds or terraform stdout — sanitised by the route at insert.
  error_message            text,

  created_at               timestamptz not null default now()
);

create index if not exists infra_drift_checks_project_id_idx
  on public.infra_drift_checks (project_id);
create index if not exists infra_drift_checks_build_id_idx
  on public.infra_drift_checks (build_id);
create index if not exists infra_drift_checks_apply_id_idx
  on public.infra_drift_checks (apply_id);

alter table public.infra_drift_checks enable row level security;

drop policy if exists infra_drift_checks_owner on public.infra_drift_checks;
create policy infra_drift_checks_owner on public.infra_drift_checks
  for all
  using (
    exists (
      select 1
      from public.projects p
      where p.id = infra_drift_checks.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      where p.id = infra_drift_checks.project_id and p.user_id = auth.uid()
    )
  );
