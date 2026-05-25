-- Aurexis Forge — Vercel deploy
-- One row per attempted deployment. env_keys stores ONLY the names of
-- variables that were set on the deployment — never the values.

create table if not exists public.deployments (
  id            uuid primary key default gen_random_uuid(),
  build_id      uuid not null references public.builds(id) on delete cascade,
  provider      text not null default 'vercel',
  project_ref   text,
  deployment_id text,
  url           text,
  status        text,
  env_keys      text[] not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists deployments_build_id_idx on public.deployments (build_id);
create index if not exists deployments_status_idx   on public.deployments (status);

-- builds.status during the deploy phase:
--   'pushed'        — repo created; ready for human authorisation
--   'deploying'     — deployment in flight on Vercel
--   'deployed'      — production deployment is READY; deploy_url populated
--   'deploy_failed' — deployment errored; user may retry
--
-- always_on / scheduled builds DO NOT enter this phase — they get routed to
-- the runtime layer instead and stay at 'pushed' until then.
