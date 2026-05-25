// Tiny environment self-check. Auth-required so we don't leak the
// existence/absence of platform env vars to anonymous visitors.
//
// Reports ONLY presence booleans + the latest applied migration marker.
// Never echoes a key, never returns the value of a secret, never logs.
//
// Use this from the dashboard / a curl after deploying to confirm:
//   - APP_ENC_KEY is set (without it BYOK token decryption breaks)
//   - E2B_API_KEY is set (only relevant when REQUIRE_BYOK=false; with
//     BYOK on, users bring their own and this is just the platform
//     fallback)
//   - the latest RLS-bearing migration (0011) has been applied to the
//     connected Supabase project

import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Bump this in lockstep with supabase/migrations/ — it is the marker the
// health probe checks for. Pick a column added in the latest migration
// that we can SELECT cheaply. The probe just confirms the schema knows
// about it.
const LATEST_MIGRATION = '0011_currency';
const MIGRATION_PROBE_TABLE = 'budgets';
const MIGRATION_PROBE_COLUMN = 'display_currency';

interface EnvPresence {
  // Required for BYOK token decryption.
  app_enc_key: boolean;
  // Platform fallback sandbox key (used only when REQUIRE_BYOK=false).
  e2b_api_key: boolean;
  // Platform fallback LLM key (same caveat as e2b_api_key).
  anthropic_api_key: boolean;
  // Required for Supabase server clients.
  supabase_url: boolean;
  supabase_service_role_key: boolean;
  supabase_anon_key: boolean;
  // Cron secret protects the runtime tick endpoint.
  cron_secret: boolean;
}

interface MigrationStatus {
  latest_expected: string;
  applied: boolean;
  // Brief, non-sensitive reason when applied=false. Never includes the
  // raw error from postgrest (which can echo SQL fragments).
  detail: string | null;
}

interface HealthBody {
  ok: boolean;
  env: EnvPresence;
  migration: MigrationStatus;
  // Whether the BYOK founder-protection flag is on. Not a secret.
  require_byok: boolean;
}

function envPresent(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

async function probeMigration(): Promise<MigrationStatus> {
  try {
    const supabase = getServerSupabase();
    const { error } = await supabase
      .from(MIGRATION_PROBE_TABLE)
      .select(MIGRATION_PROBE_COLUMN)
      .limit(1);
    if (error) {
      // 42703 = undefined column — that's the signal the migration
      // hasn't been applied. Other errors (RLS, network) get a vague
      // "probe failed" so we don't leak DB internals.
      const code = (error as { code?: string }).code;
      if (code === '42703' || /column .* does not exist/i.test(error.message)) {
        return {
          latest_expected: LATEST_MIGRATION,
          applied: false,
          detail: 'latest migration column missing',
        };
      }
      return {
        latest_expected: LATEST_MIGRATION,
        applied: false,
        detail: 'probe failed',
      };
    }
    return { latest_expected: LATEST_MIGRATION, applied: true, detail: null };
  } catch {
    return {
      latest_expected: LATEST_MIGRATION,
      applied: false,
      detail: 'probe failed',
    };
  }
}

function readRequireByok(): boolean {
  const raw = (process.env.REQUIRE_BYOK ?? 'true').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

export async function GET() {
  try {
    await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    throw err;
  }

  const env: EnvPresence = {
    app_enc_key: envPresent('APP_ENC_KEY'),
    e2b_api_key: envPresent('E2B_API_KEY'),
    anthropic_api_key: envPresent('ANTHROPIC_API_KEY'),
    supabase_url: envPresent('NEXT_PUBLIC_SUPABASE_URL'),
    supabase_service_role_key: envPresent('SUPABASE_SERVICE_ROLE_KEY'),
    supabase_anon_key: envPresent('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    cron_secret: envPresent('CRON_SECRET'),
  };

  const migration = await probeMigration();

  // "ok" = the bare-minimum platform invariants hold. BYOK fallback keys
  // (e2b, anthropic) aren't required when REQUIRE_BYOK is on, so they
  // don't gate ok.
  const ok =
    env.app_enc_key &&
    env.supabase_url &&
    env.supabase_service_role_key &&
    env.supabase_anon_key &&
    migration.applied;

  const body: HealthBody = {
    ok,
    env,
    migration,
    require_byok: readRequireByok(),
  };

  return NextResponse.json(body, { status: ok ? 200 : 503 });
}
