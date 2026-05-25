-- Aurexis Forge — external connections
-- Stores third-party credentials (currently: GitHub) with the token encrypted
-- at rest. The plaintext token only ever exists transiently in server memory
-- during a push.

create table if not exists public.connections (
  id              uuid primary key default gen_random_uuid(),
  user_id         text,
  provider        text not null default 'github',
  account_login   text,
  -- AES-256-GCM ciphertext (iv || tag || ciphertext), base64. Decrypted with
  -- APP_ENC_KEY. NEVER store plaintext here.
  token_encrypted text not null,
  scopes          text,
  created_at      timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists connections_user_id_idx  on public.connections (user_id);
create index if not exists connections_provider_idx on public.connections (provider);

-- builds.status during the push phase:
--   'tested'      — sandbox passed; ready for human authorisation
--   'pushing'     — push to GitHub in flight (between gate approval and outcome)
--   'pushed'      — repo created, initial commit pushed, repo_url populated
--   'push_failed' — push errored; user may retry after fixing the cause
