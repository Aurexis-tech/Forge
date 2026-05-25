// Unit test: BYOK key resolver + NeedsKeyError + kill-switch
// interaction.
//
// resolveKey is the single point where the Forge decides "whose fuel
// pays for this call". Three states matter:
//   1. user has a BYOK connection → source='byok'
//   2. REQUIRE_BYOK is true and no connection → NeedsKeyError
//   3. REQUIRE_BYOK is false and a platform env key exists → 'platform'
//
// Plus: even on the BYOK path, the governance kill switch is still
// authoritative. This file proves resolveKey returns BYOK correctly,
// NeedsKeyError fires when expected, AND that an active kill switch
// blocks subsequent assertAllowed() calls regardless of key source.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertAllowed, GovernanceError } from '@/lib/engine/governance/guard';
import {
  encryptSecret,
} from '@/lib/crypto';
import {
  NeedsKeyError,
  peekKeySource,
  resolveKey,
} from '@/lib/engine/keys';
import {
  createInMemoryDb,
  makeClient,
  type InMemoryDb,
} from '../helpers/in-memory-supabase';

function client(db: InMemoryDb) {
  return makeClient(db) as unknown as Parameters<typeof resolveKey>[2];
}

const USER = 'user-test-1';

const ORIGINAL_REQUIRE_BYOK = process.env.REQUIRE_BYOK;
const ORIGINAL_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  // Restore env so tests don't leak into each other.
  if (ORIGINAL_REQUIRE_BYOK === undefined) {
    delete process.env.REQUIRE_BYOK;
  } else {
    process.env.REQUIRE_BYOK = ORIGINAL_REQUIRE_BYOK;
  }
  if (ORIGINAL_ANTHROPIC_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_KEY;
  }
});

function seedAnthropicConnection(db: InMemoryDb, userId: string, key: string) {
  if (!db.tables.connections) db.tables.connections = [];
  db.tables.connections.push({
    id: 'conn-' + userId,
    user_id: userId,
    provider: 'anthropic',
    account_login: 'anthropic',
    token_encrypted: encryptSecret(key),
    scopes: 'api-key',
    key_last4: key.slice(-4),
    created_at: new Date().toISOString(),
  });
}

describe('resolveKey', () => {
  it('returns source="byok" when the user has a connection', async () => {
    const db = createInMemoryDb();
    seedAnthropicConnection(db, USER, 'sk-ant-test-payload-1234');
    const resolved = await resolveKey(USER, 'anthropic', client(db));
    expect(resolved.source).toBe('byok');
    expect(resolved.key).toBe('sk-ant-test-payload-1234');
    expect(resolved.key_last4).toBe('1234');
  });

  it('throws NeedsKeyError when REQUIRE_BYOK and no connection', async () => {
    process.env.REQUIRE_BYOK = 'true';
    const db = createInMemoryDb();
    await expect(
      resolveKey(USER, 'anthropic', client(db)),
    ).rejects.toBeInstanceOf(NeedsKeyError);
    try {
      await resolveKey(USER, 'anthropic', client(db));
    } catch (e) {
      const err = e as NeedsKeyError;
      expect(err.provider).toBe('anthropic');
      expect(err.require_byok).toBe(true);
    }
  });

  it('falls back to platform key when REQUIRE_BYOK=false and env key present', async () => {
    process.env.REQUIRE_BYOK = 'false';
    process.env.ANTHROPIC_API_KEY = 'platform-key-test';
    const db = createInMemoryDb();
    const resolved = await resolveKey(USER, 'anthropic', client(db));
    expect(resolved.source).toBe('platform');
    expect(resolved.key).toBe('platform-key-test');
  });

  it('throws NeedsKeyError even with REQUIRE_BYOK=false if no platform env', async () => {
    process.env.REQUIRE_BYOK = 'false';
    delete process.env.ANTHROPIC_API_KEY;
    const db = createInMemoryDb();
    await expect(
      resolveKey(USER, 'anthropic', client(db)),
    ).rejects.toBeInstanceOf(NeedsKeyError);
  });
});

describe('peekKeySource (non-throwing variant used by the route gate)', () => {
  it('reports byok when a connection exists', async () => {
    const db = createInMemoryDb();
    seedAnthropicConnection(db, USER, 'sk-test-xxxx');
    const peek = await peekKeySource(USER, 'anthropic', client(db));
    expect(peek.source).toBe('byok');
  });

  it('reports missing when no connection and REQUIRE_BYOK', async () => {
    process.env.REQUIRE_BYOK = 'true';
    const db = createInMemoryDb();
    const peek = await peekKeySource(USER, 'anthropic', client(db));
    expect(peek.source).toBe('missing');
  });

  it('reports missing when DB read fails (defensive)', async () => {
    process.env.REQUIRE_BYOK = 'true';
    const db = createInMemoryDb();
    // resolveKey throws on a read error, but peekKeySource swallows
    // and returns 'missing' so the guard fails-closed via the regular
    // 412 path rather than 500.
    db.forceReadError = new Error('simulated db outage');
    const peek = await peekKeySource(USER, 'anthropic', client(db));
    expect(peek.source).toBe('missing');
  });
});

describe('Kill switch still applies on the BYOK path', () => {
  // The whole point: a user bringing their own Anthropic key does
  // NOT escape the global kill switch. Otherwise BYOK becomes an
  // accidental governance bypass.
  beforeEach(() => {
    process.env.REQUIRE_BYOK = 'true';
  });

  it('blocks via GovernanceError(killed) even when keySource=byok', async () => {
    const db = createInMemoryDb();
    seedAnthropicConnection(db, USER, 'sk-ant-test-xxxx');
    db.tables.kill_switches = [
      {
        id: 'k1',
        scope: 'global',
        scope_id: null,
        active: true,
        reason: 'paused for tests',
        set_by: 'tests',
        created_at: new Date().toISOString(),
      },
    ];
    // Sanity: the key is resolvable...
    const resolved = await resolveKey(USER, 'anthropic', client(db));
    expect(resolved.source).toBe('byok');
    // ...but assertAllowed STILL refuses because the kill switch wins.
    const guardClient = client(db) as unknown as Parameters<typeof assertAllowed>[1];
    await expect(
      assertAllowed(
        {
          user_id: USER,
          projectedCostUsd: 0.05,
          keySource: 'byok',
        },
        guardClient,
      ),
    ).rejects.toMatchObject({
      name: 'GovernanceError',
      reason: 'killed',
    });
  });

  it('does NOT bypass the budget check via byok IF the kill switch is set on user scope', async () => {
    const db = createInMemoryDb();
    seedAnthropicConnection(db, USER, 'sk-ant-xxx');
    db.tables.kill_switches = [
      {
        id: 'k1',
        scope: 'user',
        scope_id: USER,
        active: true,
        reason: 'user paused',
        set_by: 'user',
        created_at: new Date().toISOString(),
      },
    ];
    const guardClient = client(db) as unknown as Parameters<typeof assertAllowed>[1];
    try {
      await assertAllowed(
        {
          user_id: USER,
          projectedCostUsd: 1.0,
          keySource: 'byok',
        },
        guardClient,
      );
      throw new Error('expected GovernanceError');
    } catch (e) {
      expect(e).toBeInstanceOf(GovernanceError);
      expect((e as GovernanceError).reason).toBe('killed');
    }
  });
});
