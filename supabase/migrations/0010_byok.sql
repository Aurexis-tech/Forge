-- Aurexis Forge — Bring-Your-Own-Key (BYOK)
--
-- Users paste their own Anthropic / E2B API keys; the engine runs on those
-- keys at zero cost to the platform. Two small additions to existing tables:

-- 1) connections.key_last4: a non-secret 4-character display hint so the
--    settings UI can show "•••• abcd" without ever decrypting the full key.
alter table public.connections
  add column if not exists key_last4 text;

-- 2) cost_events.key_source: who actually paid for this event. 'platform'
--    means the Forge's own ANTHROPIC_API_KEY / E2B_API_KEY were used (we
--    need to charge for it); 'byok' means the user's own key was used (the
--    amount_usd is informational only — they paid the provider directly).
alter table public.cost_events
  add column if not exists key_source text not null default 'platform'
    check (key_source in ('platform', 'byok'));

create index if not exists cost_events_key_source_idx
  on public.cost_events (key_source);

-- No new tables and no new audit-log columns; key add/remove events are
-- captured in audit_log via action='connection.key_added' /
-- 'connection.key_removed' with the last4 in detail (NEVER the full key).
