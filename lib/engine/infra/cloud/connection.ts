// Cloud-connection loader for the Phase 4-5a plan route.
//
// The CloudProvider seam needs an env bag (AWS_ACCESS_KEY_ID +
// AWS_SECRET_ACCESS_KEY + AWS_REGION today, GOOGLE_APPLICATION_CREDENTIALS
// later, etc.). Connection rows store ONE token (encrypted via
// lib/crypto). For the 'cloud' provider that token is a JSON blob
// of the env bag; we decrypt + parse it here.
//
// SECURITY:
//   - The decrypted env bag lives ONLY inside this function's return
//     value, passed once to the CloudProvider, and dropped immediately.
//   - The `accountHint` is the only field that lands in audit_log or
//     a response payload. It MUST be a non-secret identifier (e.g.
//     "aws-us-east-1") — the connection's account_login field is the
//     source.
//   - If the token isn't a valid JSON env bag, we return null with a
//     reason the route surfaces as a 412 ("reconnect your cloud").

import {
  loadConnectionWithToken,
} from '@/lib/engine/integrations/connections';
import type { ForgeSupabase } from '@/lib/supabase';

export interface InfraCloudConnection {
  envFromToken: Record<string, string>;
  accountHint: string | null;
}

export async function loadInfraCloudConnection(
  supabase: ForgeSupabase,
  userId: string,
): Promise<InfraCloudConnection | null> {
  const result = await loadConnectionWithToken(supabase, 'cloud', userId);
  if (!result) return null;
  const env = parseEnvBag(result.token);
  if (!env) return null;
  return {
    envFromToken: env,
    accountHint: result.row.account_login ?? null,
  };
}

function parseEnvBag(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) {
        out[k] = v;
      }
    }
    if (Object.keys(out).length === 0) return null;
    return out;
  } catch {
    return null;
  }
}
