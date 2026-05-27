-- Aurexis Forge — Phase 3 (Software) DB provisioning.
--
-- Phase 3-5a lifts the software gate one more step: a tested software
-- build can now provision (or connect) its database and apply the
-- generated RLS migration to it. This is the software-specific gate
-- the agent / system molds don't have. The actual provisioning lives
-- behind an authorisation gate (see /api/projects/[id]/software/db/
-- provision); this table records the outcome.
--
-- Two provider kinds are persisted here:
--   - 'managed'  — the Forge created a fresh Supabase project via
--                  the Supabase Management API.
--   - 'byo'      — the user supplied an existing Supabase project's
--                  connection details (URL + anon + service-role).
--
-- The service-role key is the only secret on this row. It's stored
-- AES-256-GCM-encrypted (same lib/crypto path as the runtime env +
-- the connections token) and NEVER returned in any API response.
-- The last 4 chars of the raw key are persisted in plaintext for
-- safe display ("•••• abcd"), mirroring connections.key_last4.
--
-- RLS: project-owner-scoped, mirror the rest of the platform.

create table if not exists public.software_databases (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects(id) on delete cascade,
  build_id               uuid not null references public.builds(id)   on delete cascade,
  provider_kind          text not null check (provider_kind in ('managed', 'byo')),

  -- Public-ish connection bits — anon key is bundled into the
  -- generated browser bundle so it's by definition not secret. The
  -- URL is reachable from any browser hitting the deployed app.
  supabase_url           text not null,
  anon_key               text not null,

  -- Secret. AES-256-GCM ciphertext via lib/crypto.encryptSecret.
  -- NEVER decrypted into a response payload.
  service_role_encrypted text not null,
  -- Safe-to-display: last 4 chars of the raw key for UI ("•••• abcd").
  service_role_last4     text not null,

  -- For managed provisioning: the Supabase project ref returned by
  -- the Management API. Null for BYO (the user-supplied project
  -- already has its own ref but we don't ask for it).
  provider_project_ref   text,

  -- True iff the generated RLS migration was successfully applied to
  -- the provisioned DB. Provisioning is two stages (create DB → run
  -- migration); a partial outcome lands here with migration_applied
  -- = false and the route surfaces "provisioning failed".
  migration_applied      boolean not null default false,

  created_at             timestamptz not null default now()
);

create index if not exists software_databases_project_id_idx
  on public.software_databases (project_id);
create index if not exists software_databases_build_id_idx
  on public.software_databases (build_id);

-- RLS: owner-scoped via the project. Mirror the policy shape from
-- 0009_governance.sql's plans_owner / sandbox_runs_owner blocks.

alter table public.software_databases enable row level security;

drop policy if exists software_databases_owner on public.software_databases;
create policy software_databases_owner on public.software_databases
  for all
  using (
    exists (
      select 1
      from public.projects p
      where p.id = software_databases.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      where p.id = software_databases.project_id and p.user_id = auth.uid()
    )
  );

-- builds.status during the software DB-provisioning phase:
--   'tested'        — sandbox passed; ready for human authorisation
--   'provisioning'  — DbProvider call in flight (between gate
--                     approval and outcome)
--   'provisioned'   — DB ready + migration applied; software_databases
--                     row populated
--   'provision_failed' — provisioning errored; user may retry
--
-- A 'provisioned' build is the LAST stop for kind='software' in
-- Phase 3-5a. Push + deploy + runtime stay closed.
