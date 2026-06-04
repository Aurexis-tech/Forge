-- Aurexis Forge — governed runtime actions (the runtime-governance broker).
--
-- The core invariant: a forged artifact must NOT perform a governed
-- side-effect (send email, mutate external state, spend) directly. It
-- REQUESTS the action; Forge records it here as 'pending'; a human
-- approves or blocks it; and ONLY on approval does Forge perform the
-- call with a SERVER-HELD credential. This is the runtime twin of the
-- build-time AuthorizationGate (repo.create_authorized / deploy.authorized)
-- — same principle: the human holds the keys, extended past deploy.
--
--   payload  — the action arguments (e.g. { to, subject, body } for
--              type='email.send'). Never carries a credential.
--   result   — the outcome on a successful send (e.g. { message_id }).
--   status   — pending → (executed | blocked | failed). 'pending' and
--              'blocked' NEVER produced a send.
--
-- The raw provider credential (RESEND_API_KEY) is NEVER stored in this
-- table and never reaches the artifact. It lives only in server env,
-- read by exactly one module: lib/engine/integrations/resend.ts.

create table if not exists public.governed_actions (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  -- The governed action type, e.g. 'email.send'. Open text (more types
  -- arrive as the engine learns to instrument more side-effects); the
  -- application layer validates against the known set.
  type          text not null,
  summary       text not null,
  payload       jsonb not null default '{}'::jsonb,
  risk          text not null default 'medium' check (risk in ('low', 'medium', 'high')),
  status        text not null default 'pending' check (status in (
    'pending',
    'executed',
    'blocked',
    'failed'
  )),
  -- Outcome of a successful execution (e.g. { message_id }). Null until
  -- an approved action actually performs the send.
  result        jsonb,
  -- Sanitised failure message when status='failed'. Never carries the
  -- credential or raw provider error envelope.
  error_message text,
  created_at    timestamptz not null default now(),
  -- Set when a human decides (approve/block).
  decided_at    timestamptz,
  -- 'user' on a human decision — mirrors the build-time gate's actor.
  decided_by    text
);

create index if not exists governed_actions_project_id_idx
  on public.governed_actions (project_id);
create index if not exists governed_actions_status_idx
  on public.governed_actions (status);

-- RLS: owner-scoped via the project (same posture as builds / infra_applies).
alter table public.governed_actions enable row level security;

drop policy if exists governed_actions_owner on public.governed_actions;
create policy governed_actions_owner on public.governed_actions
  for all
  using (
    exists (
      select 1
      from public.projects p
      where p.id = governed_actions.project_id and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      where p.id = governed_actions.project_id and p.user_id = auth.uid()
    )
  );

comment on table public.governed_actions is
  'Runtime governed-action ledger: an artifact requests a side-effect (e.g. '
  'email.send); Forge holds it pending until a human approves, then performs '
  'the call with a server-held credential. Runtime twin of the build-time '
  'AuthorizationGate. The provider credential is never stored here.';
