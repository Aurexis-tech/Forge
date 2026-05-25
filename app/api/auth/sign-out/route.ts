import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  const url = new URL(req.url);
  return NextResponse.redirect(new URL('/sign-in', url.origin), { status: 303 });
}
