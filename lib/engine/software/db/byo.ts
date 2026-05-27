// BYO DbProvider — the user supplies an EXISTING Supabase project's
// connection details (URL + anon + service-role) and the Forge
// applies the generated migration to it. No project creation, no
// Management API.
//
// SECURITY: same hygiene as Managed — the service-role key the user
// pastes is encrypted-at-rest by the route layer before it reaches
// any persistence row, and the raw value is dropped from any response.
//
// The migration apply path uses the project's PostgREST endpoint via
// a small RPC the generated migration's "first" Supabase project
// will already have (`rpc/exec_sql` is the standard pattern). To keep
// this initial implementation hermetic in tests we hit the same
// /v1/projects/{ref}/database/query shape — but BYO doesn't have a
// `ref` in our control. So instead, BYO uses a direct REST endpoint
// pattern under the project's URL itself: POST {url}/rest/v1/rpc/exec_sql
// with the service-role key as the auth bearer. The actual SQL exec
// path the Forge expects the user to have in their project is a one-
// time setup: documented in the UI flow.

import type {
  DbProvider,
  MigrationResult,
  ProvisionedDb,
  ProvisionInput,
} from './provider';

export class ByoDbProviderError extends Error {
  readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'ByoDbProviderError';
    this.cause = opts?.cause;
  }
}

export class ByoDbProvider implements DbProvider {
  readonly name = 'supabase-byo';
  readonly kind = 'byo' as const;

  constructor(
    private readonly fetcher: typeof fetch = (...args) =>
      globalThis.fetch(...(args as Parameters<typeof fetch>)),
  ) {}

  // BYO doesn't "provision" — it validates the user's supplied
  // connection. We do a light cred-shape check + return the same
  // ProvisionedDb shape so the route layer's downstream code is
  // identical to the managed path.
  async provision(opts: ProvisionInput): Promise<ProvisionedDb> {
    const byo = opts.byo;
    if (!byo) {
      throw new ByoDbProviderError(
        'byo provisioning requires a user-supplied connection (url + anon + service_role)',
      );
    }
    if (!byo.supabaseUrl.trim() || !byo.anonKey.trim() || !byo.serviceRoleKey.trim()) {
      throw new ByoDbProviderError(
        'byo connection fields are required: supabaseUrl, anonKey, serviceRoleKey',
      );
    }
    const url = byo.supabaseUrl.trim();
    if (!/^https:\/\//.test(url)) {
      throw new ByoDbProviderError(
        'supabaseUrl must start with https:// (got ' + safeTail(url, 80) + ')',
      );
    }
    return {
      supabaseUrl: url,
      anonKey: byo.anonKey.trim(),
      serviceRoleKey: byo.serviceRoleKey.trim(),
      providerProjectRef: null,
    };
  }

  async applyMigration(
    db: ProvisionedDb,
    sql: string,
  ): Promise<MigrationResult> {
    if (!sql.trim()) {
      return { statementsApplied: 0, ok: true, error: null };
    }
    // Hit the user's Supabase project directly via a PostgREST RPC
    // named `exec_sql`. We document this requirement in the BYO
    // flow's UI: the user must enable a small SQL helper function in
    // their project before connecting. If `exec_sql` isn't installed,
    // the apply step returns a friendly error pointing at the docs.
    let res;
    try {
      res = await this.fetcher(
        db.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/exec_sql',
        {
          method: 'POST',
          headers: {
            apikey: db.serviceRoleKey,
            Authorization: 'Bearer ' + db.serviceRoleKey,
            'content-type': 'application/json',
            // PostgREST requires this header to accept the response
            // shape we want.
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ query: sql }),
        },
      );
    } catch (err) {
      return {
        statementsApplied: 0,
        ok: false,
        error:
          'byo apply network error: ' +
          (err instanceof Error ? err.message : String(err)),
      };
    }
    if (!res.ok) {
      const tail = await res.text().catch(() => '');
      return {
        statementsApplied: 0,
        ok: false,
        error:
          'byo apply refused: ' +
          String(res.status) +
          ' — ' +
          safeTail(tail, 400),
      };
    }
    const statementsApplied = sql
      .split(/;\s*\n/)
      .filter((s) => s.trim().length > 0).length;
    return {
      statementsApplied,
      ok: true,
      error: null,
    };
  }
}

function safeTail(s: string, n: number): string {
  const trimmed = s.slice(-n);
  return trimmed
    .replace(/eyJ[A-Za-z0-9_\-\.]+/g, '[redacted-jwt]')
    .replace(/sbp_[A-Za-z0-9]+/g, '[redacted-token]');
}
