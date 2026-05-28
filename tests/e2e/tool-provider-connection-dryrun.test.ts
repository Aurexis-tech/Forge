// Hermetic dry-run — the Agent-tool-keys connect flow (Brave Search
// for web_search). Mirrors the GitHub/Vercel/Supabase PAT pattern:
// key in the BODY (never URL), VERIFIED before persist, stored
// ENCRYPTED, NEVER echoed/logged. The Brave verify call is stubbed at
// fetch — NO real provider call.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '@/lib/crypto';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

const FAKE_USER = { id: 'user-tool-provider-dry-run', email: 't@example.com' };

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, requireUser: vi.fn(async () => FAKE_USER) };
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

import { POST as savePOST } from '@/app/api/connections/tool-provider/[provider]/route';
import { POST as disconnectPOST } from '@/app/api/connections/tool-provider/[provider]/disconnect/route';
import { GET as statusGET } from '@/app/api/connections/tool-provider/route';

const ORIGINAL_FETCH = globalThis.fetch;

function stubBraveVerify(status: number) {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url?: string }).url ?? '';
    if (!url.includes('api.search.brave.com')) {
      throw new Error('[test] unexpected fetch: ' + url);
    }
    return new Response(JSON.stringify({ web: { results: [] } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function postReq(body?: unknown): Request {
  return new Request('http://test/post', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ctx(provider: string) {
  return { params: { provider } };
}

beforeEach(() => {
  dbHolder.current = null;
  globalThis.fetch = ORIGINAL_FETCH;
});

afterAll(() => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
});

const RAW_KEY = 'bsk-test-brave-key-do-not-log-XYZ123';

// ===========================================================================
// SAVE — verify-before-persist
// ===========================================================================
describe('tool-provider save — verify, then persist encrypted', () => {
  it('verify SUCCESS → stores the key ENCRYPTED; response carries no key; audit has no key', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    stubBraveVerify(200);

    const res = await savePOST(postReq({ key: RAW_KEY }), ctx('brave_search'));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { connected: boolean; provider: string };
    expect(body.connected).toBe(true);
    expect(body.provider).toBe('brave_search');
    // The raw key NEVER appears in the response.
    expect(text).not.toContain(RAW_KEY);

    // Stored ENCRYPTED — ciphertext present, decrypts back to the key,
    // and the plaintext is NOT in the stored row.
    const rows = (db.tables.connections ?? []) as Array<{
      provider: string;
      token_encrypted: string;
    }>;
    const row = rows.find((r) => r.provider === 'brave_search');
    expect(row).toBeDefined();
    expect(row!.token_encrypted).not.toContain(RAW_KEY);
    expect(decryptSecret(row!.token_encrypted)).toBe(RAW_KEY);

    // Audit row carries metadata only — never the key.
    const audits = (db.tables.audit_log ?? []) as Array<{
      action: string;
      detail: Record<string, unknown>;
    }>;
    const audit = audits.find((a) => a.action === 'connection.tool_provider_linked');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit!.detail)).not.toContain(RAW_KEY);
  });

  it('verify FAILURE (401) → 422 verify_failed; NOTHING persisted', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    stubBraveVerify(401);

    const res = await savePOST(postReq({ key: RAW_KEY }), ctx('brave_search'));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { reason: string; provider: string };
    expect(body.reason).toBe('verify_failed');
    expect(body.provider).toBe('brave_search');
    // No connection stored.
    expect((db.tables.connections ?? []).length).toBe(0);
  });

  it('unknown provider → 404 (and no fetch attempted)', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    // No fetch stub — if the route tried to verify, the global blocker fires.
    const res = await savePOST(postReq({ key: RAW_KEY }), ctx('not_a_provider'));
    expect(res.status).toBe(404);
    expect((db.tables.connections ?? []).length).toBe(0);
  });

  it('key must come from the BODY — a body-less request is 400 (never a URL param)', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const res = await savePOST(postReq(undefined), ctx('brave_search'));
    expect(res.status).toBe(400);
    expect((db.tables.connections ?? []).length).toBe(0);
  });
});

// ===========================================================================
// STATUS
// ===========================================================================
describe('tool-provider status', () => {
  it('reports not-connected when no key is stored; never returns a token', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const res = await statusGET();
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      providers: Array<{ provider: string; connected: boolean; env_key: string }>;
    };
    const brave = body.providers.find((p) => p.provider === 'brave_search');
    expect(brave).toBeDefined();
    expect(brave!.connected).toBe(false);
    expect(brave!.env_key).toBe('BRAVE_SEARCH_API_KEY');
    // No token field anywhere.
    expect(text).not.toMatch(/token/i);
  });

  it('reports connected once a key is stored (no token in the payload)', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    stubBraveVerify(200);
    await savePOST(postReq({ key: RAW_KEY }), ctx('brave_search'));
    globalThis.fetch = ORIGINAL_FETCH;

    const res = await statusGET();
    const text = await res.text();
    const body = JSON.parse(text) as {
      providers: Array<{ provider: string; connected: boolean; connected_at: string | null }>;
    };
    const brave = body.providers.find((p) => p.provider === 'brave_search')!;
    expect(brave.connected).toBe(true);
    expect(brave.connected_at).toBeTruthy();
    expect(text).not.toContain(RAW_KEY);
  });
});

// ===========================================================================
// DISCONNECT
// ===========================================================================
describe('tool-provider disconnect', () => {
  it('removes the stored connection row', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    stubBraveVerify(200);
    await savePOST(postReq({ key: RAW_KEY }), ctx('brave_search'));
    expect((db.tables.connections ?? []).length).toBe(1);
    globalThis.fetch = ORIGINAL_FETCH;

    const res = await disconnectPOST(postReq(), ctx('brave_search'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; provider: string };
    expect(body.status).toBe('removed');
    expect((db.tables.connections ?? []).length).toBe(0);
  });

  it('unknown provider → 404', async () => {
    const db = createInMemoryDb();
    dbHolder.current = db;
    const res = await disconnectPOST(postReq(), ctx('not_a_provider'));
    expect(res.status).toBe(404);
  });
});
