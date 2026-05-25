// Cron-driven scheduler entry point.
//
// SECURITY: this route MUST reject any call without a valid CRON_SECRET.
// Vercel Cron Jobs attach `Authorization: Bearer ${CRON_SECRET}` when
// CRON_SECRET is set as a project env var. We accept that, plus an
// `x-cron-secret` header for non-Vercel invocations (curl tests etc).
//
// Constant-time comparison via lib/crypto.ts.

import { NextResponse } from 'next/server';
import { safeEqual } from '@/lib/crypto';
import { tickRuntimes } from '@/lib/engine/runtime/scheduler';

export const runtime = 'nodejs';
export const maxDuration = 300;
// Cron MUST hit a fresh handler every minute; never cache.
export const dynamic = 'force-dynamic';

async function handle(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on the server' },
      { status: 500 },
    );
  }

  if (!isAuthorized(req, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const summary = await tickRuntimes();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'tick failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

function isAuthorized(req: Request, secret: string): boolean {
  const expectedBearer = 'Bearer ' + secret;
  const auth = req.headers.get('authorization') ?? '';
  if (auth.length === expectedBearer.length && safeEqual(auth, expectedBearer)) {
    return true;
  }
  const xcs = req.headers.get('x-cron-secret') ?? '';
  if (xcs.length === secret.length && safeEqual(xcs, secret)) {
    return true;
  }
  return false;
}

// Vercel Cron uses GET. We also accept POST for ergonomic tooling parity
// with the other runtime control routes.
export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
