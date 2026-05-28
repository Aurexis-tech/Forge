// HERMETICITY GUARD — self-test.
//
// Proves the global guard in tests/setup.ts is ACTIVE: production code
// that constructs a real Supabase client (via getServerSupabase ->
// createClient) throws a clear hermetic error on EVERY Node version,
// instead of silently succeeding locally and only failing in CI's
// Node 20 (the realtime getWebSocketConstructor leak that this whole
// change fixes).
//
// This test is the drift-guard for the class: if someone removes the
// setup.ts mock, this test fails (getServerSupabase would construct a
// real client and NOT throw on a modern Node). If a future test lets
// prod build a real client, IT fails with the same message at the
// call site — on the dev's machine, not just in CI.

import { describe, expect, it } from 'vitest';
import { getServerSupabase } from '@/lib/supabase';

describe('hermeticity guard — real Supabase client construction is blocked', () => {
  it('getServerSupabase() throws the hermetic guard error (guard is active globally)', () => {
    expect(() => getServerSupabase()).toThrow(
      /hermetic test constructed a REAL Supabase client/,
    );
  });

  it('the guard message points to the correct fix (mock getServerSupabase / resolveKey)', () => {
    try {
      getServerSupabase();
      expect.fail('expected getServerSupabase() to throw under the guard');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/getServerSupabase/);
      expect(msg).toMatch(/resolveKey/);
    }
  });
});
