// DbProvider factory. Mirrors lib/engine/sandbox/provider.selectProvider:
// the route layer calls selectDbProvider() with the user's
// request, gets back the right implementation, and uses the
// uniform DbProvider interface from there.
//
// Selection rule (route-layer concern, surfaced here as a pure
// function so the test can exercise both branches without going
// through the route handler):
//
//   - kind='managed' → ManagedDbProvider (route must verify the
//     'supabase' connection exists upstream and pass its decrypted
//     token).
//   - kind='byo'     → ByoDbProvider (route must verify the user
//     supplied {url, anon, service_role} in the body).

import type { DbProvider, DbProviderKind } from './provider';
import { ByoDbProvider } from './byo';
import { ManagedDbProvider } from './managed';

export function selectDbProvider(kind: DbProviderKind): DbProvider {
  if (kind === 'managed') return new ManagedDbProvider();
  if (kind === 'byo') return new ByoDbProvider();
  throw new Error('unknown DbProvider kind: ' + String(kind));
}
