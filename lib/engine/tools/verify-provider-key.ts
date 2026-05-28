// VERIFY-BEFORE-PERSIST for provider-backed tool keys.
//
// Given a tool's provider_connection.verify shape { url, method,
// header }, make a single reachability call that carries the key in
// the declared header and report whether the provider accepted it.
// The connect route uses this to verify a pasted key BEFORE storing
// it encrypted — same posture as the GitHub/Vercel/Supabase PAT
// routes (verify read-only, then persist).
//
// The fetch implementation is INJECTABLE so tests pass a mock and
// NEVER make a real provider call. The default wraps global fetch.
//
// SECURITY: the key is sent only in the declared header to the
// declared verify URL. It is never logged here and never returned.

import type { ToolProviderConnection } from './contract';

/** Minimal fetch shape the verifier needs — easy to mock in tests. */
export type VerifyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number }>;

export interface VerifyResult {
  /** True when the provider accepted the key (2xx) OR no verify shape was declared. */
  readonly ok: boolean;
  /** HTTP status of the verify call, when one was made. */
  readonly status?: number;
  /** Structured note — e.g. "no verify shape declared; accepted without a check". */
  readonly warn?: string;
}

const defaultVerifyFetch: VerifyFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers });
  return { ok: res.ok, status: res.status };
};

/**
 * Verify a provider key against the connection's declared verify
 * shape. A provider with no verify shape is accepted (we can't probe
 * it) with a structured warning. A network failure is reported as
 * not-ok with the error message in `warn`.
 */
export async function verifyProviderKey(
  connection: ToolProviderConnection,
  key: string,
  fetchImpl: VerifyFetch = defaultVerifyFetch,
): Promise<VerifyResult> {
  const verify = connection.verify;
  if (!verify) {
    return {
      ok: true,
      warn:
        'no verify shape declared for ' +
        connection.provider +
        '; key accepted without a reachability check',
    };
  }
  try {
    const res = await fetchImpl(verify.url, {
      method: verify.method,
      headers: {
        [verify.header]: key,
        Accept: 'application/json',
      },
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return {
      ok: false,
      warn: err instanceof Error ? err.message : 'verify network error',
    };
  }
}
