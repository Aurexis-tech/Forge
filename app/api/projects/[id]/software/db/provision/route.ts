// POST /api/projects/[id]/software/db/provision
//
// Phase 3-5a (Software) DB provisioning — the software-specific gate
// the agent / system molds don't have. Behind a mandatory authorisation
// gate ({ authorized: true } or 403), this route either provisions a
// fresh Supabase project via the Management API (kind='managed') or
// validates a user-supplied existing connection (kind='byo'), then
// applies the SAME generated RLS migration that the P3-4 isolation
// test already validated. Software stops here in P3-5a — push +
// deploy + runtime stay closed for kind='software'.
//
// SECURITY hygiene this route MUST uphold (assertions live in the
// hermetic dry-run test):
//   - Body requires { authorized: true } — z.literal(true). 403
//     otherwise. The DbProvider is NEVER constructed without it.
//   - The managed flow decrypts the user's supabase Management token
//     server-side and passes it directly into the provider — it never
//     enters a response or audit-log detail blob.
//   - The byo flow accepts the service-role key in the request body
//     and forwards it to persistSoftwareDatabase which encrypts it at
//     rest. The raw value is dropped from any response payload — the
//     route returns only the sanitised PublicSoftwareDatabase row.
//   - The migration applied is the EXACT generated SQL from
//     build_files (P3-3) — no edits, no fixes, no LLM in this path.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  selectDbProvider,
} from '@/lib/engine/software/db/select';
import {
  checkSoftwareProvisionConcurrency,
  loadTestedSoftwareBuildForProvision,
  logSoftwareDbAuthorized,
  logSoftwareDbFailed,
  logSoftwareDbProvisioned,
  markSoftwareBuildProvisionFailed,
  markSoftwareBuildProvisioned,
  markSoftwareBuildProvisioning,
  persistSoftwareDatabase,
  sanitizeDbForResponse,
} from '@/lib/engine/software/db/persistence';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import { projectRouteGuard } from '@/lib/route-guard';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ManagedBody = z.object({
  authorized: z.literal(true),
  provider_kind: z.literal('managed'),
  // Optional project naming + region hints forwarded to the
  // Management API. The provider clamps + defaults.
  project_name: z.string().trim().min(1).max(48).optional(),
  region: z.string().trim().min(1).max(48).optional(),
  organization_id: z.string().trim().min(1).max(120).optional(),
});

const ByoBody = z.object({
  authorized: z.literal(true),
  provider_kind: z.literal('byo'),
  supabase_url: z.string().trim().url().max(400),
  anon_key: z.string().trim().min(20).max(8000),
  // The service-role key is the only secret in this body — it is
  // forwarded to persistSoftwareDatabase which encrypts immediately.
  service_role_key: z.string().trim().min(20).max(8000),
});

const BodySchema = z.discriminatedUnion('provider_kind', [ManagedBody, ByoBody]);

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;
  // Provisioning itself doesn't spend LLM tokens or sandbox compute —
  // the cost is a Supabase project at the org's plan tier. Keep the
  // governance pre-check at 0; the kill-switch + ownership checks
  // still run.
  const guard = await projectRouteGuard(projectId, { projectedCostUsd: 0 });
  if ('error' in guard) {
    return NextResponse.json(guard.body, { status: guard.status });
  }
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    // AUTHORIZATION GATE: refuse anything that doesn't carry an
    // explicit { authorized: true } + a recognised provider_kind. 403
    // is the same shape the other gates use; mention what's needed.
    return NextResponse.json(
      {
        error:
          'request body must include { "authorized": true, "provider_kind": "managed" | "byo", ... } — the user must explicitly approve provisioning a real database',
      },
      { status: 403 },
    );
  }

  const supabase = getServerSupabase();

  // Walk the (project → tested software build → spec → plan →
  // generated migration) chain. Any misroute / wrong kind / wrong
  // status surfaces here as a clean 4xx.
  const ctx = await loadTestedSoftwareBuildForProvision(supabase, projectId);
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { project, build, migrationSql } = ctx;

  // Refuse a double-provision — if a software_databases row with
  // migration_applied=true already exists for this build, the user
  // would clobber a live DB by pressing Provision twice.
  const conc = await checkSoftwareProvisionConcurrency(supabase, build.id);
  if ('error' in conc) {
    return NextResponse.json({ error: conc.error }, { status: conc.status });
  }

  // Audit the authorisation BEFORE acting so consent is recorded even
  // if a crash occurs mid-provision.
  await logSoftwareDbAuthorized(supabase, build, parsed.data.provider_kind);

  // Resolve provider-specific inputs. The managed branch needs a
  // user-connected Supabase Management token; the byo branch carries
  // its inputs in the request body.
  let provisionInput: import('@/lib/engine/software/db/provider').ProvisionInput;
  if (parsed.data.provider_kind === 'managed') {
    const conn = await loadConnectionWithToken(supabase, 'supabase', user.id);
    if (!conn) {
      return NextResponse.json(
        {
          error:
            "no 'supabase' connection found — connect your Supabase Management token before choosing the managed flow",
        },
        { status: 412 },
      );
    }
    provisionInput = {
      managementToken: conn.token,
      projectName: parsed.data.project_name,
      region: parsed.data.region,
      metadata: parsed.data.organization_id
        ? { organization_id: parsed.data.organization_id }
        : undefined,
    };
  } else {
    provisionInput = {
      byo: {
        supabaseUrl: parsed.data.supabase_url,
        anonKey: parsed.data.anon_key,
        serviceRoleKey: parsed.data.service_role_key,
      },
    };
  }

  await markSoftwareBuildProvisioning(supabase, build.id);

  const provider = selectDbProvider(parsed.data.provider_kind);

  // Stage 1 — provision (or validate) the DB connection.
  let provisioned: import('@/lib/engine/software/db/provider').ProvisionedDb;
  try {
    provisioned = await provider.provision(provisionInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markSoftwareBuildProvisionFailed(supabase, build.id);
    await logSoftwareDbFailed(supabase, build, {
      provider_kind: parsed.data.provider_kind,
      stage: 'provision',
      message,
    });
    return NextResponse.json(
      { error: 'provisioning failed: ' + message },
      { status: 502 },
    );
  }

  // Stage 2 — apply the generated RLS migration. We persist a
  // software_databases row regardless of the migration result so the
  // user can retry from 'provision_failed' without losing the
  // already-created project; the row carries migration_applied=false
  // until a successful apply.
  const migration = await provider.applyMigration(provisioned, migrationSql);

  let row;
  try {
    row = await persistSoftwareDatabase(supabase, {
      projectId: project.id,
      buildId: build.id,
      providerKind: parsed.data.provider_kind,
      supabaseUrl: provisioned.supabaseUrl,
      anonKey: provisioned.anonKey,
      // SECRET. persistSoftwareDatabase encrypts via lib/crypto
      // before the insert; the raw value is dropped from any
      // response below by sanitizeDbForResponse.
      serviceRoleKey: provisioned.serviceRoleKey,
      providerProjectRef: provisioned.providerProjectRef,
      migrationApplied: migration.ok,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markSoftwareBuildProvisionFailed(supabase, build.id);
    await logSoftwareDbFailed(supabase, build, {
      provider_kind: parsed.data.provider_kind,
      stage: 'apply_migration',
      message: 'persistence failed: ' + message,
    });
    return NextResponse.json(
      { error: 'failed to persist provisioned DB: ' + message },
      { status: 500 },
    );
  }

  if (!migration.ok) {
    await markSoftwareBuildProvisionFailed(supabase, build.id);
    await logSoftwareDbFailed(supabase, build, {
      provider_kind: parsed.data.provider_kind,
      stage: 'apply_migration',
      message: migration.error ?? 'migration apply failed',
    });
    return NextResponse.json(
      {
        error:
          'database created but migration failed: ' +
          (migration.error ?? 'unknown reason') +
          ' — retry to re-apply',
        // Surface the sanitised row so the UI can show "DB created,
        // schema not yet applied" without leaking the service-role.
        database: sanitizeDbForResponse(row),
      },
      { status: 502 },
    );
  }

  await markSoftwareBuildProvisioned(supabase, build.id);
  await logSoftwareDbProvisioned(supabase, build, {
    provider_kind: parsed.data.provider_kind,
    supabase_url: provisioned.supabaseUrl,
    provider_project_ref: provisioned.providerProjectRef,
    statements_applied: migration.statementsApplied,
    service_role_last4: row.service_role_last4,
  });

  // Sanitise the row before returning it. The encrypted blob + raw
  // service-role key never leave the server.
  return NextResponse.json({
    status: 'provisioned',
    kind: 'software',
    database: sanitizeDbForResponse(row),
    statements_applied: migration.statementsApplied,
  });
}
