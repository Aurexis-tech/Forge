-- Aurexis Forge — Phase 4-5a (Infrastructure) REAL TERRAFORM PLAN +
-- TYPED DESTRUCTIVE-CONFIRM GATE.
--
-- The first real-cloud step in the engine. P4-5a runs a REAL
-- `terraform plan` against live cloud state (read-only — the first
-- real cloud call), classifies it (pure-create vs DESTRUCTIVE),
-- re-checks the cost ceiling against the REAL plan, and gates
-- forward behind:
--
--   - pure-create plan -> the standard AuthorizationGate
--   - DESTRUCTIVE plan -> a server-verified TYPED CONFIRM (an exact
--                         phrase the user must type — a click is NOT
--                         enough)
--
-- NOTHING is applied here. The apply (the only real-cloud write) is
-- P4-5b, a separate gated step. The split is on purpose: real money
-- and irreversible changes begin at apply.
--
-- RLS: project-owner-scoped, mirror infra_previews / software_databases.

create table if not exists public.infra_plans (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references public.projects(id) on delete cascade,
  build_id                 uuid not null references public.builds(id)   on delete cascade,

  -- The structured plan diff, grouped by create / change / destroy.
  -- Same JSONB shape as InfraPlanDiff in lib/engine/infra/cloud/provider.ts.
  -- Diff is INERT — sanitised at the cloud-provider boundary (no raw
  -- creds, no secret values). Stored verbatim so the audit + UI read
  -- one source of truth.
  plan_diff                jsonb not null,

  -- Quick-grep classification surfaced into a column so the UI + the
  -- confirm-plan gate read it without parsing the JSON blob.
  destructive              boolean not null default false,

  -- Counts derived from the diff. Denormalised for the dashboard +
  -- audit-log readability; recomputable from plan_diff.
  create_count             integer not null default 0,
  change_count             integer not null default 0,
  destroy_count            integer not null default 0,

  -- Ceiling re-check against the REAL plan (not the P4-4 estimate).
  -- An over_budget verdict here BLOCKS the gate (status -> 'plan_blocked').
  -- 'within_budget' and 'no_budget_set' both unlock the gate.
  ceiling_verdict          text not null check (ceiling_verdict in (
    'within_budget',
    'over_budget',
    'no_budget_set'
  )),
  ceiling_period           text check (ceiling_period in ('monthly', 'daily')),
  ceiling_limit_usd        numeric(12,2),
  ceiling_projected_usd    numeric(12,4),
  ceiling_message          text not null,

  -- Confirmed-by — populated when the user passes the gate. NULL
  -- while the plan is still in the gate (status='planning' or
  -- 'plan_blocked'). Carries:
  --   - confirmed_by_user_id : auth.uid() at the moment of confirm
  --   - typed_phrase_required: the exact phrase the destructive gate
  --                            asked for (denormalised so the audit
  --                            row carries it without consulting a
  --                            separate code path)
  --   - typed_phrase_verified: true ONLY after server-side exact-match
  --                            check; for a pure-create gate this is
  --                            true vacuously
  --   - confirmed_at         : timestamp
  confirmed_by_user_id     uuid,
  typed_phrase_required    text,
  typed_phrase_verified    boolean not null default false,
  confirmed_at             timestamptz,

  created_at               timestamptz not null default now()
);

create index if not exists infra_plans_project_id_idx
  on public.infra_plans (project_id);
create index if not exists infra_plans_build_id_idx
  on public.infra_plans (build_id);

-- RLS: owner-scoped via the project. Mirror infra_previews_owner from
-- 0024_infra_previews.sql.

alter table public.infra_plans enable row level security;

drop policy if exists infra_plans_owner on public.infra_plans;
create policy infra_plans_owner on public.infra_plans
  for all
  using (
    exists (
      select 1
      from public.projects p
      where p.id = infra_plans.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      where p.id = infra_plans.project_id and p.user_id = auth.uid()
    )
  );

-- ConnectionProvider — extend to allow 'cloud' so the CloudProvider
-- seam has a stored, encrypted, per-user credential to read.
-- connections.provider is a free-form text column in 0006_github.sql;
-- no CHECK to update. The lib/types.ts ConnectionProvider union picks
-- up the new value alongside this migration.

-- builds.status during the infrastructure plan phase:
--   'previewed'      — P4-4 preview passed; ready for the real plan
--   'planning'       — `terraform plan` in flight against real cloud
--                      state (read-only)
--   'plan_blocked'   — real-plan cost re-check over budget OR a
--                      destructive gate refused (the user backed out
--                      or typed-confirm mismatched)
--   'plan_confirmed' — the user passed the gate (AuthorizationGate
--                      for pure-create, server-verified TYPED CONFIRM
--                      for destructive); the build is READY TO APPLY,
--                      but APPLY is P4-5b — nothing has been written
--                      to the cloud yet
--
-- The build_status text column has no CHECK constraint, so these
-- values land without a constraint migration. lib/types.ts BuildStatus
-- union is extended alongside this migration.
