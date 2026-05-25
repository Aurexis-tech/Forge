// Authentication middleware.
//
// Two jobs:
//   1. Refresh the Supabase session cookie on every request so the user's
//      session never silently expires under them.
//   2. Redirect unauthenticated users to /sign-in for protected paths.
//
// Open paths (never require auth):
//   - /sign-in
//   - /auth/* (Supabase OAuth + magic link callbacks)
//   - /api/auth/* (sign-out, etc)
//   - /api/runtime/tick (CRON_SECRET protected, no user session)
//   - /api/connections/*/callback (third-party OAuth landings)

import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseMiddlewareClient } from '@/lib/auth';

const OPEN_PREFIXES = [
  '/sign-in',
  '/auth',
  '/api/auth',
  '/api/runtime/tick',
  '/api/connections/github/callback',
  '/api/connections/vercel/callback',
];

export async function middleware(req: NextRequest) {
  const res = NextResponse.next({ request: req });
  const supabase = createSupabaseMiddlewareClient(req, res);

  // Refresh session (no-op if absent / fresh).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = req.nextUrl.pathname;

  // The public marketing landing. Signed-in users get bounced to the
  // app entry; signed-out users see the marketing.
  if (pathname === '/') {
    if (user) {
      const url = req.nextUrl.clone();
      url.pathname = '/projects';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return res;
  }

  const isOpen = OPEN_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p + '?'),
  );

  if (!user && !isOpen) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('next', pathname + (req.nextUrl.search || ''));
    return NextResponse.redirect(url);
  }

  // If already signed in and visiting /sign-in, bounce to /projects.
  if (user && pathname === '/sign-in') {
    const url = req.nextUrl.clone();
    url.pathname = '/projects';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  // Match everything except Next.js internals + static assets. We can't
  // skip API routes here — they need session refresh too.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)'],
};
