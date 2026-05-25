// Supabase Auth callback — exchanges the magic-link code for a session
// cookie and redirects to the original page (or /projects by default).

import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const nextRaw = url.searchParams.get('next') ?? '/projects';
  const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/projects';

  if (!code) {
    return NextResponse.redirect(new URL('/sign-in?auth_error=missing_code', url.origin));
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL('/sign-in?auth_error=' + encodeURIComponent(error.message), url.origin),
    );
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
