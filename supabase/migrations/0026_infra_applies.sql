-- Aurexis Forge — Phase 4-5b (Infrastructure) APPLY + ROLLBACK.
--
-- The single write to real cloud in the entire engine. P4-5b runs
-- ONLY a plan confirmed in P4-5a, applies EXACTLY that confirmed
-- plan artifact (so what's applied matches what the user confirmed),
-- captures encrypted state, and supports gated rollback on failure.
-- The kill switch can halt it — both PRE-apply (assertAllowed
-- refuses) and MID-apply (a watcher polls and aborts the spawned
-- terraform process).
--
-- ONLY one apply per build can succeed. infra_applies rows persist:
--   - the encrypted terraform state (AES-256-GCM via lib/crypto) —
--     terraform state may contain secrets (e.g. RDS master passwords
--     surfaced as resource attributes); we store the WHOLE state
--     encrypted so a single accidental read can't leak secrets.
--   - the SANITISED outputs (catalog-aware sanitiser strips secret-
--     shaped strings; safe to render in the UI)
--   - apply outcome (succeeded / failed / killswitched / destroyed) +
--     resource counts for the audit + dashboard
--   - the actual cost amount (billed to the ledger as a 'runtime'
--     event so the user's monthly budget tracks real accrued cost)
--
-- RLS: project-owner-scoped, mirror infra_previews + infra_plans.
--
-- builds.status during P4-5b:
--   'plan_confirmed'  — entry: P4-5a gate passed
--   'applying'        — apply in flight (the only path that writes
--                       to real cloud)
--   'provisioned'     — apply succeeded; live infrastructure exists;
--                       encrypted state stored; ledger billed
--   'apply_failed'    — apply errored OR was killswitched mid-flight;
--                       PARTIAL state captured + encrypted; NO
--                       auto-destroy. User must explicitly run a
--                       gated rollback via /infra/build/destroy.
--   'destroying'      — destroy/rollback in flight
--   'destroyed'       — destroy completed; resources removed; the
--                       row stays for audit + replay

create table if not exists public.infra_applies (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references public.projects(id) on delete cascade,
  build_id                 uuid not null references public.builds(id)   on delete cascade,
  -- Reference to the confirmed plan this apply was started from.
  -- Apply runs the SAVED ARTIFACT from this row's plan; a hostile
  -- caller can't sneak in a different plan.
  plan_id                  uuid not null references public.infra_plans(id) on delete restrict,

  -- Outcome — pinned to the four states the apply route writes.
  -- 'destroyed' is also reachable from a successful destroy (which
  -- re-uses this row to capture the destroy outcome).
  status                   text not null check (status in (
    'applying',
    'succeeded',
    'failed',
    'killswitched',
    'destroying',
    'destroyed'
  )),

  -- Whether the apply was halted by the kill-switch mid-flight.
  -- Distinguished from a generic 'failed' so the audit + UI can
  -- surface the right cause.
  killswitched             boolean not null default false,
  -- True iff a PARTIAL state was captured (the apply got partway
  -- through before erroring/aborting). The terraform state file
  -- carries everything that DID succeed; rollback uses it.
  partial_state            boolean not null default false,

  -- Resource counts the apply actually wrote (terraform reports an
  -- 'applied / added / changed / destroyed' summary on stop). When
  -- the apply was killswitched these reflect what completed BEFORE
  -- the abort, not the planned total.
  resources_added          integer not null default 0,
  resources_changed        integer not null default 0,
  resources_destroyed      integer not null default 0,

  -- ENCRYPTED terraform state. Server-only. NEVER returned in any
  -- API response, NEVER logged. AES-256-GCM via lib/crypto.
  state_encrypted          text,
  -- Convenience marker — true iff state_encrypted is non-null. Same
  -- check the route could derive but denormalised so RLS-aware
  -- selects can filter by it without forcing a column read.
  state_present            boolean not null default false,

  -- SANITISED outputs. The cloud-provider boundary scrubs secret-
  -- shaped strings before the outputs reach this column. Safe to
  -- render in the UI; still avoid surfacing it verbatim in audit
  -- detail blobs.
  outputs_sanitised        jsonb not null default '{}'::jsonb,

  -- Actual cost amount billed to the ledger ($USD/month at the
  -- moment of apply). Mirrors the same number that lands in the
  -- cost_events row this apply emits.
  billed_usd_per_month     numeric(12,2) not null default 0,

  -- Free-form error message captured on failure. NEVER carries
  -- secrets/state/creds — the route sanitises before insert.
  error_message            text,

  created_at               timestamptz not null default now(),
  finished_at              timestamptz
);

create index if not exists infra_applies_project_id_idx
  on public.infra_applies (project_id);
create index if not exists infra_applies_build_id_idx
  on public.infra_applies (build_id);
create index if not exists infra_applies_status_idx
  on public.infra_applies (status);

-- RLS: owner-scoped via the project.
alter table public.infra_applies enable row level security;

drop policy if exists infra_applies_owner on public.infra_applies;
create policy infra_applies_owner on public.infra_applies
  for all
  using (
    exists (
      select 1
      from public.projects p
      where p.id = infra_applies.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      where p.id = infra_applies.project_id and p.user_id = auth.uid()
    )
  );

-- Extend infra_plans with the saved-plan artifact. P4-5a now
-- persists the terraform-plan binary file's contents (base64) so
-- the apply step can pass it back to `terraform apply` verbatim. The
-- column is nullable for backward-compat with rows written before
-- this migration; the apply route refuses any plan row whose
-- artifact is null.
alter table public.infra_plans
  add column if not exists plan_artifact_b64 text;

-- builds.status text column has no CHECK constraint; lib/types.ts
-- BuildStatus union is extended alongside this migration to include
-- 'applying' / 'apply_failed' / 'destroying' / 'destroyed'. The
-- 'provisioned' state is already in the union (added in P3-5a) and
-- is re-used here — both software and infrastructure builds can
-- reach 'provisioned'.
