// Managed DbProvider — calls the Supabase Management API to create a
// fresh Supabase project under the user's account, then applies the
// generated migration via the project's SQL endpoint.
//
// The Management API surface used here:
//   POST /v1/projects                — create a new project, return its
//                                       URL + anon key + service-role
//                                       key + project ref.
//   POST /v1/projects/{ref}/database/query
//                                     — run a SQL statement against
//                                       the project's Postgres. We
//                                       use this to apply the
//                                       generated RLS migration one
//                                       statement at a time.
//
// SECURITY: the management token is server-only; the service-role
// key returned from the create call is server-only too. Neither is
// ever logged, ever returned to the client, or ever persisted in
// plaintext.

import type {
  DbProvider,
  MigrationResult,
  ProvisionedDb,
  ProvisionInput,
} from './provider';

const MANAGEMENT_API = 'https://api.supabase.com';

export class ManagedDbProviderError extends Error {
  readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'ManagedDbProviderError';
    this.cause = opts?.cause;
  }
}

export class ManagedDbProvider implements DbProvider {
  readonly name = 'supabase-managed';
  readonly kind = 'managed' as const;

  // Optional fetch override for tests. In production the provider
  // uses globalThis.fetch directly.
  constructor(
    private readonly fetcher: typeof fetch = (...args) =>
      globalThis.fetch(...(args as Parameters<typeof fetch>)),
  ) {}

  async provision(opts: ProvisionInput): Promise<ProvisionedDb> {
    const token = opts.managementToken;
    if (!token) {
      throw new ManagedDbProviderError(
        'managed provisioning requires a Supabase Management token',
      );
    }
    const projectName = (opts.projectName ?? 'forge-software-app').slice(
      0,
      48,
    );
    const region = opts.region ?? 'us-east-1';

    let res;
    try {
      res = await this.fetcher(MANAGEMENT_API + '/v1/projects', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: projectName,
          // The Management API needs an org_id (the metadata.org_id
          // is the user's pick) and a region. The route layer puts
          // these into opts.metadata; we forward them verbatim.
          organization_id: opts.metadata?.organization_id ?? '',
          db_pass: opts.metadata?.db_pass ?? randomPassword(),
          region,
          // plan: 'free' on the free tier. The Forge defaults to
          // 'free' so creating a project doesn't surprise the user
          // with a bill.
          plan: opts.metadata?.plan ?? 'free',
        }),
      });
    } catch (err) {
      throw new ManagedDbProviderError(
        'management api network error: ' +
          (err instanceof Error ? err.message : String(err)),
        { cause: err },
      );
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new ManagedDbProviderError(
        'management api refused project create: ' +
          String(res.status) +
          (bodyText ? ' — ' + safeTail(bodyText, 400) : ''),
      );
    }
    let body: ManagementCreateResponse;
    try {
      body = (await res.json()) as ManagementCreateResponse;
    } catch (err) {
      throw new ManagedDbProviderError(
        'management api returned non-json body: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    // Pull the URL + anon + service-role from the response. The
    // exact shape depends on the Management API version; we accept
    // a couple of common shapes defensively.
    const url =
      body.api_url ??
      (body.ref ? 'https://' + body.ref + '.supabase.co' : null);
    const anon = body.anon_key ?? body.api_keys?.anon ?? null;
    const serviceRole =
      body.service_role_key ?? body.api_keys?.service_role ?? null;
    const ref = body.ref ?? null;
    if (!url || !anon || !serviceRole) {
      throw new ManagedDbProviderError(
        'management api response missing url / anon / service_role',
      );
    }

    return {
      supabaseUrl: url,
      anonKey: anon,
      serviceRoleKey: serviceRole,
      providerProjectRef: ref,
    };
  }

  async applyMigration(
    db: ProvisionedDb,
    sql: string,
  ): Promise<MigrationResult> {
    if (!db.providerProjectRef) {
      return {
        statementsApplied: 0,
        ok: false,
        error: 'managed apply requires a providerProjectRef',
      };
    }
    if (!sql.trim()) {
      return {
        statementsApplied: 0,
        ok: true,
        error: null,
      };
    }

    // The Management API's database/query endpoint accepts a single
    // SQL string (multiple statements allowed). We use the
    // service-role key on the project itself for auth (not the
    // management token — apply is project-scoped, not org-scoped).
    let res;
    try {
      res = await this.fetcher(
        MANAGEMENT_API +
          '/v1/projects/' +
          db.providerProjectRef +
          '/database/query',
        {
          method: 'POST',
          headers: {
            // The Management API accepts the same bearer the
            // /projects endpoint did. We pass it through opts in
            // production via a closure; here we expect the route
            // layer to set up auth before calling applyMigration if
            // a different token is needed. For the initial impl we
            // re-use the service-role key on the project itself —
            // it can run arbitrary SQL by definition.
            Authorization: 'Bearer ' + db.serviceRoleKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query: sql }),
        },
      );
    } catch (err) {
      return {
        statementsApplied: 0,
        ok: false,
        error:
          'apply network error: ' +
          (err instanceof Error ? err.message : String(err)),
      };
    }
    if (!res.ok) {
      const tail = await res.text().catch(() => '');
      return {
        statementsApplied: 0,
        ok: false,
        error:
          'apply refused: ' + String(res.status) + ' — ' + safeTail(tail, 400),
      };
    }
    // Count the semicolon-separated statements we asked for so the
    // audit log can show "N statements applied" even though the
    // Management API treats it as one query.
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

// ---------------------------------------------------------------------------
// Wire-format types for the Supabase Management API responses we
// actually consume. Kept narrow + defensive: missing fields are
// tolerated and surfaced as a clean ManagedDbProviderError.
// ---------------------------------------------------------------------------

interface ManagementCreateResponse {
  ref?: string;
  api_url?: string;
  anon_key?: string;
  service_role_key?: string;
  api_keys?: {
    anon?: string;
    service_role?: string;
  };
}

function randomPassword(): string {
  // Used only when the route layer didn't pass db_pass. The
  // service-role key returned by the API is the actual privileged
  // credential; the db password is just for direct-Postgres access
  // which the generated app never uses. Still — make it long +
  // random + ASCII-safe.
  const bytes = new Uint8Array(24);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Buffer.from(bytes).toString('base64url');
}

function safeTail(s: string, n: number): string {
  // Trim any obvious secrets out of error text before surfacing it.
  // The Management API doesn't echo creds in errors, but be belt-
  // and-braces.
  const trimmed = s.slice(-n);
  return trimmed
    .replace(/eyJ[A-Za-z0-9_\-\.]+/g, '[redacted-jwt]')
    .replace(/sbp_[A-Za-z0-9]+/g, '[redacted-token]');
}
