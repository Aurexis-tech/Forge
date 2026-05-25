// Per-user authentication via Supabase Auth.
//
// The Forge has two Supabase clients:
//   - Service-role (lib/supabase.getServerSupabase): bypasses RLS, used by
//     route handlers for privileged writes. Routes are responsible for
//     ownership checks before using it on user-scoped rows.
//   - Anon + user session (this file): respects RLS, used to read the
//     current user. Always reflects the cookie-bound session.

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies as nextCookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
// Database generic intentionally omitted from createServerClient calls —
// see the note in lib/supabase.ts. The Supabase Auth surface we use here
// (getUser / exchangeCodeForSession / signOut) doesn't depend on the
// Database shape anyway.

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('[aurexis-forge] Missing required env var: ' + name);
  return v;
}

// Client used inside Server Components, Route Handlers, and Server Actions.
// Reads cookies via next/headers; writes cookies for session refresh.
export function createSupabaseServerClient() {
  const url = readEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anon = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const jar = nextCookies();
  return createServerClient(url, anon, {
    cookies: {
      get(name: string) {
        return jar.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          jar.set({ name, value, ...options });
        } catch {
          // Server Components can't write cookies — silently ignore.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          jar.set({ name, value: '', ...options, maxAge: 0 });
        } catch {
          // Same as above.
        }
      },
    },
  });
}

// Variant used inside Next.js middleware where cookies are read/written
// through the request + response objects, not next/headers.
export function createSupabaseMiddlewareClient(
  req: NextRequest,
  res: NextResponse,
) {
  const url = readEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anon = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return createServerClient(url, anon, {
    cookies: {
      get(name: string) {
        return req.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        res.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        res.cookies.set({ name, value: '', ...options, maxAge: 0 });
      },
    },
  });
}

export interface AuthedUser {
  id: string;
  email: string | null;
}

// Returns the current user or null. Use this in pages / routes that may
// render in a signed-out state.
export async function getUser(): Promise<AuthedUser | null> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  const u = data.user;
  if (!u) return null;
  return { id: u.id, email: u.email ?? null };
}

// Returns the current user or throws. Use this in routes that require a
// signed-in user (essentially all of them outside of /auth/* and /sign-in).
export async function requireUser(): Promise<AuthedUser> {
  const u = await getUser();
  if (!u) {
    throw new UnauthorizedError('not signed in');
  }
  return u;
}

export class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

// Helper for project-scoped routes. Loads the project via the service-role
// client (so RLS doesn't get in the way) but then asserts ownership against
// the authenticated user. Returns the project row, a 404-shaped error if it
// doesn't exist, or a 403-shaped error if the user doesn't own it.
import { getServerSupabase } from './supabase';
import type { Project } from './types';

export async function requireProjectOwnership(
  projectId: string,
  user: AuthedUser,
): Promise<
  | { project: Project }
  | { error: string; status: number }
> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .maybeSingle();
  if (error) return { error: error.message, status: 500 };
  if (!data) return { error: 'project not found', status: 404 };
  const project = data as Project;
  if (project.user_id !== user.id) {
    return { error: 'forbidden', status: 403 };
  }
  return { project };
}
