// Friendly key-gate helpers for cost-incurring routes.
//
// Two flavours:
//   - ensureBYOK(userId, provider) — call BEFORE the work starts. Returns
//     a 412 NextResponse if no key is connected (and REQUIRE_BYOK is on),
//     or null to proceed. Burns nothing if the user has no key.
//   - needsKeyResponse(err) — call from a catch around the work. Maps a
//     thrown NeedsKeyError into the same 412 shape. Defence-in-depth for
//     the race where the key vanishes mid-flight.
//
// Both produce the SAME body shape so the UI's NeedsKeyGate can render
// without caring which path triggered it.

import { NextResponse } from 'next/server';
import {
  isRequireByok,
  NeedsKeyError,
  peekKeySource,
} from '@/lib/engine/keys';
import type { ByokProvider } from '@/lib/types';

interface NeedsKeyBody {
  error: string;
  reason: 'needs_key';
  provider: ByokProvider;
  require_byok: boolean;
}

function buildBody(provider: ByokProvider, require_byok: boolean): NeedsKeyBody {
  return {
    error: 'connect your ' + provider + ' key to continue',
    reason: 'needs_key',
    provider,
    require_byok,
  };
}

/**
 * Pre-flight peek. If the user has no usable key for `provider` and
 * REQUIRE_BYOK is on, returns a 412 response the route should return
 * verbatim. Returns null otherwise.
 */
export async function ensureBYOK(
  userId: string,
  provider: ByokProvider,
): Promise<NextResponse | null> {
  const peek = await peekKeySource(userId, provider);
  if (peek.source !== 'missing') return null;
  return NextResponse.json(buildBody(provider, isRequireByok()), {
    status: 412,
  });
}

/**
 * Map a thrown NeedsKeyError to a 412 response. Returns null for any
 * other error type — caller falls through to its normal error handling.
 */
export function needsKeyResponse(err: unknown): NextResponse | null {
  if (!(err instanceof NeedsKeyError)) return null;
  return NextResponse.json(
    buildBody(err.provider, err.require_byok),
    { status: 412 },
  );
}
