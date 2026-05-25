// Typed Supabase clients.
//
// - `getBrowserSupabase()`  — anon key, safe in client components.
// - `getServerSupabase()`   — service role key, ONLY usable in server code
//                             (route handlers, server actions, RSC). Throws
//                             if accidentally imported into a client bundle.
//
// NOTE on typing: we deliberately use the untyped `SupabaseClient` form
// rather than `SupabaseClient<Database>`. Threading `<Database>` through
// every `.from('table').insert(...)` requires the generated supabase-CLI
// types (with all the `GenericSchema` machinery: Relationships shapes,
// Views, Functions, Enums, CompositeTypes — and the exact internal
// helpers that match the installed @supabase/postgrest-js version). The
// hand-maintained `Database` shape in lib/types.ts is the source of
// truth for ROW types throughout the codebase, but it doesn't fully
// satisfy postgrest-js's narrow generic constraint, which causes every
// insert/update to collapse to `never`.
//
// Future improvement: replace lib/types.ts Database with `supabase gen
// types typescript` output and tighten this back to <Database>. Until
// then, the application-level row types (Project, Spec, etc) provide all
// the practical safety we need — every persistence helper casts the
// data back into them.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Server-side callers cast results back through the application row
// types in lib/types.ts (Project, Spec, Build, etc) so we don't lose
// practical type safety on reads.
export type ForgeSupabase = SupabaseClient;

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[aurexis-forge] Missing required env var: ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

let browserClient: ForgeSupabase | null = null;

export function getBrowserSupabase(): ForgeSupabase {
  if (browserClient) return browserClient;
  const url = readEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anon = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  browserClient = createClient(url, anon, {
    auth: { persistSession: false },
  });
  return browserClient;
}

export function getServerSupabase(): ForgeSupabase {
  if (typeof window !== 'undefined') {
    throw new Error(
      '[aurexis-forge] getServerSupabase() must not be called from the browser.',
    );
  }
  const url = readEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
