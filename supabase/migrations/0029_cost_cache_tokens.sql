-- Aurexis Forge — prompt-cache token accounting on cost_events.
--
-- Additive columns on `public.cost_events` (created in 0009_governance).
-- Anthropic prompt caching splits an LLM call's input into three
-- buckets: tokens written to the cache, tokens read from the cache, and
-- the uncached remainder (the existing `input_tokens`, which the API now
-- reports as the post-breakpoint count). Capturing the two cache buckets
-- here lets the ledger compute the true, discounted amount_usd (cache
-- read = 0.1x base input, write = 1.25x) and lets the dashboard show a
-- real cache hit-rate + savings number on the first real forge.
--
-- Both default 0, so every existing row + every non-LLM / non-cached
-- event reads back as "no cache activity" — existing reads are
-- unaffected and the change is backward compatible.
--
-- RLS POSTURE: cost_events RLS already scopes rows to the owning user;
-- adding columns does not change row visibility, so no policy change.

alter table public.cost_events
  add column if not exists cache_creation_input_tokens integer not null default 0;

alter table public.cost_events
  add column if not exists cache_read_input_tokens integer not null default 0;

comment on column public.cost_events.cache_creation_input_tokens is
  'Anthropic prompt-cache: tokens WRITTEN to the cache on this call (billed at 1.25x base input, 5-minute TTL). Default 0.';

comment on column public.cost_events.cache_read_input_tokens is
  'Anthropic prompt-cache: tokens READ from the cache on this call (billed at 0.1x base input — the savings lever). Default 0.';
