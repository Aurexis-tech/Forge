-- Aurexis Forge — security hardening (Supabase advisor remediation).
--
-- 1) public.apply_token_delta is SECURITY DEFINER (it must bypass RLS to write
--    the token-wallet ledger). Postgres grants EXECUTE to PUBLIC by default, so
--    without this revoke the function is reachable by the anon/authenticated
--    roles through PostgREST at /rest/v1/rpc/apply_token_delta — letting any
--    caller mutate wallet balances and bypass governance. Wallet deltas are
--    server-only (invoked with the service-role key, which keeps its explicit
--    grant from 0030/0031), so revoke the public-facing grants.
revoke execute on function public.apply_token_delta(uuid, bigint, text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;

-- 2) Pin search_path on the timestamp trigger functions
--    (advisor 0011_function_search_path_mutable). They only call now(), so an
--    empty search_path is safe and prevents search_path-based hijacking.
alter function public.touch_builds_updated_at() set search_path = '';
alter function public.touch_agent_runtimes_updated_at() set search_path = '';
