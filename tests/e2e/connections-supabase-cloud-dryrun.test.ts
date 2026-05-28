// Hermetic end-to-end dry-run — /settings/connections SUPABASE +
// CLOUD panels. Mirrors the GitHub/Vercel pattern: token in the
// body (never URL), verified read-only before persisting,
// encrypted at rest via lib/crypto, NEVER returned in any response
// or audit row.
//
// External verify calls are stubbed:
//   - Supabase Management /v1/organizations → stubbed at fetch
//   - AWS STS GetCallerIdentity → the entire lib/engine/integrations/
//     aws-sts module is stubbed via vi.mock
//
// NO real network. NO real DB. NO real cloud calls.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '@/lib/crypto';
import type { Connection } from '@/lib/types';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

// ---------------------------------------------------------------------------
// Module-level boundary mocks. Set BEFORE importing the route handlers.
// ---------------------------------------------------------------------------

const FAKE_USER = {
  id: 'user-connections-supabase-cloud-dry-run',
  email: 'test@example.com',
};

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    requireUser: vi.fn(async () => FAKE_USER),
  };
});

const dbHolder: { current: InMemoryDb | null } = { current: null };
vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>();
  return {
    ...actual,
    getServerSupabase: vi.fn(() => {
      const db = dbHolder.current;
      if (!db) throw new Error('test forgot to seed dbHolder.current');
      return makeClient(db);
    }),
  };
});

// AWS STS — stubbed end-to-end. The cloud /pat + /test routes both
// import this module; replacing it here means no SigV4 + no real
// HTTPS call ever fires.
vi.mock('@/lib/engine/integrations/aws-sts', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/engine/integrations/aws-sts')
  >();
  return {
    ...actual,
    stsGetCallerIdentity: vi.fn(),
  };
});

import { POST as supabasePatPOST } from '@/app/api/connections/supabase/pat/route';
import { POST as supabaseTestPOST } from '@/app/api/connections/supabase/test/route';
import { POST as cloudPatPOST } from '@/app/api/connections/cloud/pat/route';
import { POST as cloudTestPOST } from '@/app/api/connections/cloud/test/route';
import { stsGetCallerIdentity } from '@/lib/engine/integrations/aws-sts';

// ---------------------------------------------------------------------------
// Fetch stub — only used by the Supabase Management verify path.
// AWS STS is stubbed at the module level above. We replace
// globalThis.fetch on a per-test basis with a tiny scripted version
// that matches the URL prefix and returns canned JSON.
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

interface SupabaseFetchScript {
  // Match by URL substring. Each entry is consumed once in order.
  match: string;
  // HTTP status to return.
  status: number;
  // Body to return as JSON.
  body: unknown;
}

function installSupabaseFetchScript(script: SupabaseFetchScript[]) {
  const queue = [...script];
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url?: string }).url ?? '';
    const next = queue.shift();
    if (!next) {
      throw new Error(
        '[test] unexpected fetch (no script remaining): ' + url,
      );
    }
    if (!url.includes(next.match)) {
      throw new Error(
        '[test] fetch url mismatch — expected ' +
          next.match +
          ', got ' +
          url,
      );
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
}

function makePost(body?: unknown): Request {
  return new Request('http://test/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterAll(() => {
  vi.restoreAllMocks();
  restoreFetch();
});

beforeEach(() => {
  dbHolder.current = null;
  vi.mocked(stsGetCallerIdentity).mockReset();
  restoreFetch();
});

// ===========================================================================
// SUPABASE MANAGEMENT
// ===========================================================================
describe('Settings · Supabase Management connection', () => {
  it('connect: stores token ENCRYPTED; response carries identity only; raw token NEVER in response or audit', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    installSupabaseFetchScript([
      {
        match: '/v1/organizations',
        status: 200,
        body: [{ id: 'org_abc', name: 'Acme Prod', slug: 'acme-prod' }],
      },
    ]);

    const RAW_TOKEN = 'sbp_test_real_PAT_value_do_not_log_me_12345';

    const res = await supabasePatPOST(makePost({ token: RAW_TOKEN }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      status: string;
      provider: string;
      account_login: string;
    };
    expect(body.status).toBe('connected');
    expect(body.provider).toBe('supabase');
    expect(body.account_login).toBe('Acme Prod');

    // ====== SECRET HYGIENE — raw token NEVER in the response. ======
    expect(text).not.toContain(RAW_TOKEN);

    // Connection row exists, token encrypted, decryptable back.
    const conns = (db.tables.connections ?? []) as Array<Record<string, unknown>>;
    expect(conns).toHaveLength(1);
    const row = conns[0] as unknown as Connection;
    expect(row.provider).toBe('supabase');
    expect(row.account_login).toBe('Acme Prod');
    expect(row.token_encrypted).not.toBe(RAW_TOKEN);
    expect(row.token_encrypted).not.toContain(RAW_TOKEN);
    expect(decryptSecret(row.token_encrypted)).toBe(RAW_TOKEN);

    // Audit row: connection.supabase_linked present; never the token.
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'connection.supabase_linked')).toBe(
      true,
    );
    for (const r of audit) {
      const serialised = JSON.stringify(r);
      expect(serialised).not.toContain(RAW_TOKEN);
    }
  });

  it('connect: maps 401 from Supabase to a clean "invalid or revoked" error; no row written', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    installSupabaseFetchScript([
      { match: '/v1/organizations', status: 401, body: { message: 'unauthorized' } },
    ]);

    const RAW_TOKEN = 'sbp_bad_token_value_should_not_be_logged_12345';
    const res = await supabasePatPOST(makePost({ token: RAW_TOKEN }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/invalid or revoked/i);

    expect((db.tables.connections ?? []).length).toBe(0);
  });

  it('connect: refuses an empty body with a clear error', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const res = await supabasePatPOST(makePost({}));
    expect(res.status).toBe(400);
    expect((db.tables.connections ?? []).length).toBe(0);
  });

  it('test-connection: success path returns identity; updates account_login; token never returned', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const RAW_TOKEN = 'sbp_test_pat_for_test_route_value';
    // Seed an existing supabase connection (as if /pat ran earlier).
    db.tables.connections = [
      {
        id: 'conn-sb-1',
        user_id: FAKE_USER.id,
        provider: 'supabase',
        account_login: 'Old Org',
        token_encrypted: (
          await import('@/lib/crypto')
        ).encryptSecret(RAW_TOKEN),
        scopes: null,
        key_last4: null,
        created_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];
    installSupabaseFetchScript([
      {
        match: '/v1/organizations',
        status: 200,
        body: [{ id: 'org_def', name: 'Fresh Org', slug: 'fresh-org' }],
      },
    ]);

    const res = await supabaseTestPOST();
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      ok: boolean;
      account_login: string;
      org_count: number;
    };
    expect(body.ok).toBe(true);
    expect(body.account_login).toBe('Fresh Org');
    expect(body.org_count).toBe(1);

    // Token NEVER in response.
    expect(text).not.toContain(RAW_TOKEN);

    // account_login refreshed in the DB.
    const conn = (db.tables.connections ?? [])[0] as
      | { account_login?: string }
      | undefined;
    expect(conn?.account_login).toBe('Fresh Org');
  });

  it('test-connection: 404 when no connection stored', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const res = await supabaseTestPOST();
    expect(res.status).toBe(404);
  });

  it('test-connection: maps 401 from Supabase to "invalid or revoked"; returns 200 with ok:false', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    db.tables.connections = [
      {
        id: 'conn-sb-1',
        user_id: FAKE_USER.id,
        provider: 'supabase',
        account_login: 'Old Org',
        token_encrypted: (
          await import('@/lib/crypto')
        ).encryptSecret('sbp_stale_pat'),
        scopes: null,
        key_last4: null,
        created_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];
    installSupabaseFetchScript([
      { match: '/v1/organizations', status: 401, body: { message: 'no' } },
    ]);

    const res = await supabaseTestPOST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid or revoked/i);
  });
});

// ===========================================================================
// CLOUD CREDENTIALS (AWS)
// ===========================================================================
describe('Settings · Cloud credentials (AWS) connection', () => {
  it('connect: STS verifies; stores env bag ENCRYPTED; raw keys NEVER in response/audit', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    vi.mocked(stsGetCallerIdentity).mockResolvedValue({
      accountId: '111122223333',
      arn: 'arn:aws:iam::111122223333:user/forge-iam-user',
      userId: 'AIDA-EXAMPLE',
    });

    const RAW_ACCESS_KEY = 'AKIAFORGEDOREALLYFAKE';
    const RAW_SECRET = 'really-fake-secret-do-not-log-me-XYZABC123456';
    const REGION = 'us-east-1';

    const res = await cloudPatPOST(
      makePost({
        AWS_ACCESS_KEY_ID: RAW_ACCESS_KEY,
        AWS_SECRET_ACCESS_KEY: RAW_SECRET,
        AWS_REGION: REGION,
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      status: string;
      provider: string;
      aws_account_id: string;
      aws_caller_arn: string;
    };
    expect(body.status).toBe('connected');
    expect(body.provider).toBe('cloud');
    expect(body.aws_account_id).toBe('111122223333');
    expect(body.aws_caller_arn).toContain('arn:aws:iam::');

    // STS was called with EXACTLY the supplied creds.
    expect(vi.mocked(stsGetCallerIdentity)).toHaveBeenCalledTimes(1);
    const stsArgs = vi.mocked(stsGetCallerIdentity).mock.calls[0]?.[0];
    expect(stsArgs?.accessKeyId).toBe(RAW_ACCESS_KEY);
    expect(stsArgs?.secretAccessKey).toBe(RAW_SECRET);
    expect(stsArgs?.region).toBe(REGION);

    // ====== SECRET HYGIENE — raw keys NEVER in the response. ======
    expect(text).not.toContain(RAW_ACCESS_KEY);
    expect(text).not.toContain(RAW_SECRET);

    // Connection row encrypted; decrypts back to the env bag JSON.
    const conns = (db.tables.connections ?? []) as Array<Record<string, unknown>>;
    expect(conns).toHaveLength(1);
    const row = conns[0] as unknown as Connection;
    expect(row.provider).toBe('cloud');
    expect(row.token_encrypted).not.toContain(RAW_ACCESS_KEY);
    expect(row.token_encrypted).not.toContain(RAW_SECRET);
    const decryptedBag = JSON.parse(decryptSecret(row.token_encrypted)) as Record<
      string,
      string
    >;
    expect(decryptedBag.AWS_ACCESS_KEY_ID).toBe(RAW_ACCESS_KEY);
    expect(decryptedBag.AWS_SECRET_ACCESS_KEY).toBe(RAW_SECRET);
    expect(decryptedBag.AWS_REGION).toBe(REGION);

    // ====== AUDIT HYGIENE — never the raw access/secret keys. ======
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    expect(audit.some((r) => r.action === 'connection.cloud_linked')).toBe(true);
    for (const r of audit) {
      const serialised = JSON.stringify(r);
      expect(serialised).not.toContain(RAW_ACCESS_KEY);
      expect(serialised).not.toContain(RAW_SECRET);
    }
    // But the public identity IS recorded so the audit is useful.
    const linkedRow = audit.find(
      (r) => r.action === 'connection.cloud_linked',
    ) as { detail?: Record<string, unknown> } | undefined;
    expect(linkedRow?.detail?.aws_account_id).toBe('111122223333');
  });

  it('connect: maps STS auth failure to a clean error; NO row written; raw keys never logged', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const { AwsStsError } = await import(
      '@/lib/engine/integrations/aws-sts'
    );
    vi.mocked(stsGetCallerIdentity).mockRejectedValue(
      new AwsStsError(
        'cloud credentials rejected by AWS STS (invalid, revoked, or insufficient permission)',
        { status: 403 },
      ),
    );

    const RAW_ACCESS_KEY = 'AKIABADKEYBADKEYBAD0';
    const RAW_SECRET = 'rejected-secret-never-logged-987654321';
    const res = await cloudPatPOST(
      makePost({
        AWS_ACCESS_KEY_ID: RAW_ACCESS_KEY,
        AWS_SECRET_ACCESS_KEY: RAW_SECRET,
        AWS_REGION: 'us-east-1',
      }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    const body = JSON.parse(text) as { error?: string };
    expect(body.error).toMatch(/rejected by AWS STS/i);

    // No row written, no audit entry leaks the keys.
    expect((db.tables.connections ?? []).length).toBe(0);
    expect(text).not.toContain(RAW_ACCESS_KEY);
    expect(text).not.toContain(RAW_SECRET);
    const audit = (db.tables.audit_log ?? []) as Array<Record<string, unknown>>;
    for (const r of audit) {
      const serialised = JSON.stringify(r);
      expect(serialised).not.toContain(RAW_ACCESS_KEY);
      expect(serialised).not.toContain(RAW_SECRET);
    }
  });

  it('connect: refuses malformed body (missing required AWS_* fields) with 400', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;

    const noBody = await cloudPatPOST(makePost({}));
    expect(noBody.status).toBe(400);

    const partial = await cloudPatPOST(
      makePost({ AWS_ACCESS_KEY_ID: 'AKIAFORGEDOREALLYFAKE' }),
    );
    expect(partial.status).toBe(400);

    expect((db.tables.connections ?? []).length).toBe(0);
    // STS NEVER called on a malformed body.
    expect(vi.mocked(stsGetCallerIdentity)).toHaveBeenCalledTimes(0);
  });

  it('test-connection: success path returns identity; updates account_login + arn; raw keys never returned', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const RAW_ACCESS_KEY = 'AKIATESTROUTEFAKE000';
    const RAW_SECRET = 'test-route-secret-do-not-log-FFFFFFFFFFFF';
    db.tables.connections = [
      {
        id: 'conn-cloud-1',
        user_id: FAKE_USER.id,
        provider: 'cloud',
        account_login: 'aws-old-account-us-east-1',
        token_encrypted: (
          await import('@/lib/crypto')
        ).encryptSecret(
          JSON.stringify({
            AWS_ACCESS_KEY_ID: RAW_ACCESS_KEY,
            AWS_SECRET_ACCESS_KEY: RAW_SECRET,
            AWS_REGION: 'us-east-1',
          }),
        ),
        scopes: null,
        key_last4: null,
        created_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];
    vi.mocked(stsGetCallerIdentity).mockResolvedValue({
      accountId: '444455556666',
      arn: 'arn:aws:iam::444455556666:user/forge-iam',
      userId: 'AIDA-2',
    });

    const res = await cloudTestPOST();
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      ok: boolean;
      aws_account_id: string;
      aws_caller_arn: string;
      account_login: string;
    };
    expect(body.ok).toBe(true);
    expect(body.aws_account_id).toBe('444455556666');
    expect(body.aws_caller_arn).toContain('arn:aws:iam::');
    expect(body.account_login).toBe('aws-444455556666-us-east-1');

    // Raw keys not in the response.
    expect(text).not.toContain(RAW_ACCESS_KEY);
    expect(text).not.toContain(RAW_SECRET);

    // STS got the decrypted keys but the test response carries only
    // identity metadata.
    const stsArgs = vi.mocked(stsGetCallerIdentity).mock.calls[0]?.[0];
    expect(stsArgs?.accessKeyId).toBe(RAW_ACCESS_KEY);
    expect(stsArgs?.secretAccessKey).toBe(RAW_SECRET);

    // account_login + scopes (arn) refreshed.
    const reloaded = (db.tables.connections ?? [])[0] as
      | { account_login?: string; scopes?: string }
      | undefined;
    expect(reloaded?.account_login).toBe('aws-444455556666-us-east-1');
    expect(reloaded?.scopes).toContain('arn:aws:iam::');
  });

  it('test-connection: 404 when no cloud connection stored', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const res = await cloudTestPOST();
    expect(res.status).toBe(404);
  });

  it('test-connection: maps STS rejection to "rejected by AWS STS"; returns 200 with ok:false', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    db.tables.connections = [
      {
        id: 'conn-cloud-1',
        user_id: FAKE_USER.id,
        provider: 'cloud',
        account_login: 'aws-old',
        token_encrypted: (
          await import('@/lib/crypto')
        ).encryptSecret(
          JSON.stringify({
            AWS_ACCESS_KEY_ID: 'AKIASTALEKEYFAKE0000',
            AWS_SECRET_ACCESS_KEY: 'stale-secret-FFFFFFFFFFFFFFFFFFFFFFF',
            AWS_REGION: 'us-east-1',
          }),
        ),
        scopes: null,
        key_last4: null,
        created_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    ];
    const { AwsStsError } = await import(
      '@/lib/engine/integrations/aws-sts'
    );
    vi.mocked(stsGetCallerIdentity).mockRejectedValue(
      new AwsStsError(
        'cloud credentials rejected by AWS STS (invalid, revoked, or insufficient permission)',
        { status: 403 },
      ),
    );

    const res = await cloudTestPOST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/rejected by AWS STS/i);
  });
});

// ===========================================================================
// HERMETICITY
// ===========================================================================
describe('Settings · connections dry-run hermeticity', () => {
  it('zero real fetch calls — STS module stubbed; Supabase fetch is the install-scripted vi.fn', async () => {
    // We DELIBERATELY replace fetch per-test for the Supabase route;
    // restoreFetch() in beforeEach brings back the setup.ts throwing
    // mock for any other call site. So between tests, any leaked
    // fetch would throw.
    const f = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(f).toBeDefined();
    // After beforeEach restoreFetch(), the fetch from tests/setup.ts
    // is the throwing async one — proof no test left a stub installed.
    // setup.ts uses `async (...) => { throw ... }`, so the throw
    // surfaces as a rejected promise — assert via `.rejects`.
    await expect(
      (f as unknown as (...args: unknown[]) => Promise<unknown>)(
        'http://will-throw.invalid',
      ),
    ).rejects.toThrow(/real fetch\(\) blocked/);
  });
});
