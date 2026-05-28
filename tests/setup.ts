// Vitest setup — runs once per worker, before any test file.
//
// Two jobs:
//   1. Stamp out every "real provider" env var so a forgotten mock can't
//      accidentally make a billed call. We replace each one with an
//      obviously fake placeholder so test code can still read them
//      (e.g. validators that just check non-empty).
//   2. Set REQUIRE_BYOK to a deterministic value so tests don't drift
//      based on the developer's local env.

import { vi } from 'vitest';

// HERMETICITY GUARD — fail fast when a test lets PRODUCTION code
// construct a REAL Supabase client.
//
// The leak this prevents: code like resolveKey() / route handlers
// default to getServerSupabase(), which calls
// `createClient(@supabase/supabase-js)`. A real client's realtime
// layer calls getWebSocketConstructor(), which throws on Node 20
// (CI) but SUCCEEDS on Node 24 (local) — so a non-hermetic test
// passes locally and only fails in CI. By mocking createClient to
// throw on EVERY Node version, the class fails on the dev's machine
// instead.
//
// `getServerSupabase` constructs lazily (inside the function, never
// at import), so this guard only fires when unmocked prod code
// actually calls it at runtime. Hermetic tests mock `@/lib/supabase`
// (getServerSupabase) or `@/lib/engine/keys` (resolveKey) and never
// reach here. Tests that genuinely need a Supabase shape pass an
// in-memory mock client explicitly.
//
// vi.mock in a setupFiles module is applied to every test file.
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: () => {
      throw new Error(
        '[tests] hermetic test constructed a REAL Supabase client. ' +
          'Mock getServerSupabase via vi.mock("@/lib/supabase"), or mock ' +
          'resolveKey via vi.mock("@/lib/engine/keys"), or pass an ' +
          'in-memory client explicitly — never let production code build a ' +
          'real client in a test.',
      );
    },
  };
});

// Anthropic + E2B keys must not be the developer's real ones.
process.env.ANTHROPIC_API_KEY = 'test-key-anthropic-disabled';
process.env.E2B_API_KEY = 'test-key-e2b-disabled';

// Supabase env — point at a non-resolvable host so a leaked call fails
// fast rather than hitting a real Supabase project.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://aurexis-forge-tests.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key-disabled';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-disabled';

// The Forge's encryption key (AES-256-GCM) — base64 of EXACTLY 32
// bytes (lib/crypto.ts asserts the decoded length). The value below is
// base64('AurexisForgeTestEncryptionKey_32') — a recognisable but
// non-secret placeholder for tests.
process.env.APP_ENC_KEY =
  Buffer.from('AurexisForgeTestEncryptionKey_32').toString('base64');

// Default BYOK to OFF so tests that don't explicitly opt-in get
// platform-key behaviour. Individual tests can override.
process.env.REQUIRE_BYOK = 'false';

// Silence the engine's structured logger across the test suite.
// Individual tests that need to inspect log output can override
// LOG_LEVEL inside the test, but the default is silent so the
// 500+ test suite doesn't fill CI output with JSON noise.
process.env.LOG_LEVEL = 'silent';

// Hard-fail any test that tries to use real `fetch`. Tests that need
// fetch behaviour should mock it explicitly. This is the last-resort
// net for hermeticity.
const originalFetch = globalThis.fetch;
globalThis.fetch = vi.fn(async (...args: unknown[]) => {
  const url =
    args[0] instanceof URL
      ? args[0].toString()
      : typeof args[0] === 'string'
        ? args[0]
        : '<unknown>';
  throw new Error(
    '[tests] real fetch() blocked — ' +
      url +
      ' (mock this call site explicitly if you need it)',
  );
}) as typeof fetch;
// Stash so a specific test can opt-back in if it genuinely needs the
// real fetch (none should).
(globalThis as unknown as { __originalFetch: typeof fetch }).__originalFetch =
  originalFetch;
