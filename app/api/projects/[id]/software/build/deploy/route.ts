// POST /api/projects/[id]/software/build/deploy
//
// Phase 3-5b (Software) deploy — deploys a pushed software bundle to
// Vercel with the provisioned Supabase DB env wired in. REUSES the
// Phase 1 `deployBuildToVercel` integration AS-IS; only the loader,
// the kind='software' status flips, the DB-env wiring, and the audit
// actions are software-specific.
//
// AUTHORIZATION GATE — request body MUST include
// `{ "authorized": true }`. The Phase 1/2 paths use the same flag; we
// re-validate it here as defence in depth.
//
// ENV-WIRING SECURITY CONTRACT — non-negotiable:
//
//   1. SUPABASE_URL + the anon key land as PUBLIC env vars
//      (NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY).
//      Vercel `type: 'plain'`. These are public-by-design — the anon
//      key is bundled into the browser JS, and RLS in the database is
//      the only barrier between an anon caller and another user's
//      rows.
//
//   2. The SERVICE-ROLE key lands as a SERVER-ONLY ENCRYPTED env var
//      (SUPABASE_SERVICE_ROLE_KEY). Vercel `type: 'encrypted'`. It
//      MUST NEVER carry a NEXT_PUBLIC_ prefix — the service-role
//      bypasses RLS, so leaking it to the browser bundle exposes
//      every tenant's data. The route enforces this with a hard-fail
//      assertion before the Vercel set call, AND with a key-prefix
//      filter on the public env list.
//
//   3. The service-role plaintext lives ONLY in the local variable
//      that holds it between decrypt-from-software_databases and the
//      Vercel env POST. It is dropped from scope immediately after
//      `deployBuildToVercel` returns, NEVER logged, NEVER returned in
//      any response, NEVER persisted to audit_log detail.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireProjectOwnership, requireUser, UnauthorizedError } from '@/lib/auth';
import {
  assertAllowed,
  GovernanceError,
  governanceBlockResponse,
} from '@/lib/engine/governance/guard';
import { loadConnectionWithToken } from '@/lib/engine/integrations/connections';
import {
  VercelDeployError,
  deployBuildToVercel,
  type VercelEnvVar,
} from '@/lib/engine/integrations/vercel';
import {
  decryptServiceRole,
  loadLatestSoftwareDatabase,
} from '@/lib/engine/software/db/persistence';
import {
  checkSoftwareDeployConcurrency,
  insertSoftwareDeploymentRow,
  loadPushedSoftwareBuildForDeploy,
  logSoftwareDeployAuthorized,
  logSoftwareDeployFailed,
  logSoftwareDeployed,
  markSoftwareBuildDeployFailed,
  markSoftwareBuildDeployed,
  markSoftwareBuildDeploying,
  markSoftwareDeploymentFailed,
  markSoftwareDeploymentReady,
} from '@/lib/engine/software/integrations/persistence';
import { auditEngineError } from '@/lib/engine/observability/audit-engine-error';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 600;

const SecretsSchema = z.record(z.string().min(1), z.string().max(8000));
const BodySchema = z.object({
  authorized: z.literal(true),
  // Optional additional secrets (anything the generated app needs
  // beyond the wired DB env — e.g. Resend, Stripe). These flow through
  // the same Vercel env API. Service-role MUST NOT be passed here —
  // the route always derives it from the encrypted software_databases
  // row, never from the request body.
  secrets: SecretsSchema.optional(),
});

// The generated Next.js app builds with the `nextjs` Vercel preset.
const SOFTWARE_VERCEL_FRAMEWORK = 'nextjs';

// Canonical env keys for the Supabase wiring. The keys are PUBLIC vs
// SERVER-ONLY by name convention AND by Vercel env `type` — the route
// asserts both bindings before calling Vercel.
const PUBLIC_SUPABASE_URL_KEY = 'NEXT_PUBLIC_SUPABASE_URL';
const PUBLIC_SUPABASE_ANON_KEY = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';
const SERVER_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

interface RouteContext {
  params: { id: string };
}

export async function POST(req: Request, { params }: RouteContext) {
  const projectId = params.id;

  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  const ownership = await requireProjectOwnership(projectId, user);
  if ('error' in ownership) {
    return NextResponse.json(
      { error: ownership.error },
      { status: ownership.status },
    );
  }
  const project = ownership.project;

  try {
    await assertAllowed({
      user_id: user.id,
      project_id: projectId,
      projectedCostUsd: 0,
    });
  } catch (err) {
    if (err instanceof GovernanceError) {
      const { status, body } = governanceBlockResponse(err);
      return NextResponse.json(body, { status });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'request body must include { "authorized": true } — the user must explicitly approve the software deploy',
      },
      { status: 403 },
    );
  }
  const incomingSecrets = parsed.data.secrets ?? {};

  // Defence in depth: the user MUST NOT supply a service-role via the
  // request. The route always reads it from the encrypted DB row. A
  // user-supplied value here would be silently overwritten — refuse
  // loudly instead so a misuse is obvious.
  if (SERVER_SUPABASE_SERVICE_ROLE_KEY in incomingSecrets) {
    return NextResponse.json(
      {
        error:
          'SUPABASE_SERVICE_ROLE_KEY must not be supplied in the request body — it is wired from the provisioned database record',
      },
      { status: 400 },
    );
  }
  // Anything that LOOKS like a NEXT_PUBLIC_SUPABASE_* override in the
  // body is also refused — those keys are wired from the DB record so
  // the deployed app can't accidentally point at a different project.
  if (
    PUBLIC_SUPABASE_URL_KEY in incomingSecrets ||
    PUBLIC_SUPABASE_ANON_KEY in incomingSecrets
  ) {
    return NextResponse.json(
      {
        error:
          'NEXT_PUBLIC_SUPABASE_* keys must not be supplied in the request body — they are wired from the provisioned database record',
      },
      { status: 400 },
    );
  }

  const supabase = getServerSupabase();

  const guard = await loadPushedSoftwareBuildForDeploy(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { build, files } = guard;

  // --- Concurrency --------------------------------------------------------
  const conc = await checkSoftwareDeployConcurrency(supabase, build.id);
  if ('error' in conc) {
    return NextResponse.json({ error: conc.error }, { status: conc.status });
  }

  // --- Load the provisioned DB row (P3-5a) --------------------------------
  const dbRow = await loadLatestSoftwareDatabase(supabase, build.id);
  if (!dbRow) {
    return NextResponse.json(
      {
        error:
          'no provisioned database record found for this software build; complete the provisioning step first',
      },
      { status: 409 },
    );
  }
  if (!dbRow.migration_applied) {
    return NextResponse.json(
      {
        error:
          'provisioned database has not had its migration applied; re-run provisioning before deploying',
      },
      { status: 409 },
    );
  }

  // --- Connection ---------------------------------------------------------
  const conn = await loadConnectionWithToken(supabase, 'vercel', user.id);
  if (!conn) {
    return NextResponse.json(
      { error: 'Vercel is not connected; complete the connect flow first' },
      { status: 412 },
    );
  }
  const teamId = parseTeamId(conn.row.scopes);

  // --- Build the Vercel env list ------------------------------------------
  //
  // Public vars (anon key + URL) → type: 'plain'. They're the only env
  // bound for the browser bundle.
  // Server-only secret (service-role) → type: 'encrypted'. The
  // decrypted value lives here ONLY between this line and the Vercel
  // set call below.
  // loadLatestSoftwareDatabase returns the FULL row including the
  // encrypted blob. decryptServiceRole is the ONLY decryption seam in
  // the codebase — keeping the call colocated with the env-set call
  // below means the plaintext lifetime is one stack frame wide.
  const serviceRolePlaintext = decryptServiceRole(dbRow);

  const wiredDbEnv: VercelEnvVar[] = [
    {
      key: PUBLIC_SUPABASE_URL_KEY,
      value: dbRow.supabase_url,
      secret: false,
    },
    {
      key: PUBLIC_SUPABASE_ANON_KEY,
      value: dbRow.anon_key,
      secret: false,
    },
    {
      key: SERVER_SUPABASE_SERVICE_ROLE_KEY,
      value: serviceRolePlaintext,
      secret: true,
    },
  ];

  // Merge any user-supplied extra secrets. We treat them all as
  // secrets (type: 'encrypted') unless they carry the NEXT_PUBLIC_
  // prefix, in which case they're plain. Anything that conflicts with
  // a wired DB key was already refused above.
  const extraEnv: VercelEnvVar[] = Object.entries(incomingSecrets)
    .filter(([, v]) => Boolean(v))
    .map(([key, value]) => ({
      key,
      value,
      secret: !key.startsWith('NEXT_PUBLIC_'),
    }));

  const envForVercel: VercelEnvVar[] = [...wiredDbEnv, ...extraEnv];

  // HARD ASSERT — the service-role MUST land as a secret (encrypted)
  // env var and MUST NOT carry a NEXT_PUBLIC_ prefix. This protects
  // against a future refactor accidentally classifying it as public.
  const serviceRoleEntry = envForVercel.find(
    (e) => e.key === SERVER_SUPABASE_SERVICE_ROLE_KEY,
  );
  if (!serviceRoleEntry || serviceRoleEntry.secret !== true) {
    return NextResponse.json(
      { error: 'internal: service-role env not classified secret' },
      { status: 500 },
    );
  }
  if (
    envForVercel.some(
      (e) =>
        e.key.startsWith('NEXT_PUBLIC_') &&
        e.value === serviceRolePlaintext,
    )
  ) {
    return NextResponse.json(
      { error: 'internal: service-role value leaked into a NEXT_PUBLIC_ env var' },
      { status: 500 },
    );
  }

  const envKeysSet = envForVercel.map((e) => e.key);
  const publicKeys = envForVercel.filter((e) => !e.secret).map((e) => e.key);
  const serverOnlyKeys = envForVercel.filter((e) => e.secret).map((e) => e.key);

  // --- Audit BEFORE acting ------------------------------------------------
  // NEVER include any value in the detail blob — only the KEY NAMES +
  // their public-vs-secret classification.
  await logSoftwareDeployAuthorized(
    supabase,
    build,
    conn.row.account_login ?? null,
    envKeysSet,
    files.length,
    publicKeys,
    serverOnlyKeys,
  );

  // --- Mark in flight + insert deployments row ----------------------------
  await markSoftwareBuildDeploying(supabase, build.id);
  let depRow;
  try {
    depRow = await insertSoftwareDeploymentRow(supabase, build.id, envKeysSet);
  } catch (rowErr) {
    return NextResponse.json(
      {
        error:
          rowErr instanceof Error
            ? rowErr.message
            : 'failed to insert software deployment row',
      },
      { status: 500 },
    );
  }

  // --- Deploy -------------------------------------------------------------
  try {
    const result = await deployBuildToVercel({
      token: conn.token,
      teamId,
      projectName: project.name,
      framework: SOFTWARE_VERCEL_FRAMEWORK,
      files,
      env: envForVercel,
    });

    await markSoftwareBuildDeployed(supabase, build.id, result.deployment_url);
    await markSoftwareDeploymentReady(supabase, depRow.id, {
      project_ref: result.project_ref,
      deployment_id: result.deployment_id,
      url: result.deployment_url,
      env_keys: result.env_keys_set,
    });
    await logSoftwareDeployed(supabase, build, {
      deployment_id: result.deployment_id,
      project_ref: result.project_ref,
      project_name: result.project_name,
      deploy_url: result.deployment_url,
      env_keys: result.env_keys_set,
    });

    // The response carries ONLY safe metadata. No env values, no
    // service-role, no anon key, no tokens.
    return NextResponse.json({
      status: 'deployed',
      kind: 'software',
      url: result.deployment_url,
      project_ref: result.project_ref,
      deployment_id: result.deployment_id,
      env_public_keys: publicKeys,
      env_server_only_keys: serverOnlyKeys,
    });
  } catch (err) {
    const isV = err instanceof VercelDeployError;
    const message = err instanceof Error ? err.message : String(err);
    const logTail = isV ? (err as VercelDeployError).logTail ?? null : null;

    await markSoftwareBuildDeployFailed(supabase, build.id);
    await markSoftwareDeploymentFailed(supabase, depRow.id);
    await logSoftwareDeployFailed(supabase, build, message, logTail);
    await auditEngineError({
      supabase,
      projectId,
      action: 'software.deploy_failed',
      err,
      actor: 'integration.vercel',
      extra: {
        build_id: build.id,
        error: message,
        log_tail: logTail ? logTail.slice(-2000) : null,
      },
    });

    return NextResponse.json({ error: message, log_tail: logTail }, { status: 502 });
  }
}

// --- Helpers ---------------------------------------------------------------

function parseTeamId(scopes: string | null): string | null {
  if (!scopes) return null;
  if (scopes.startsWith('team:')) return scopes.slice('team:'.length);
  return null;
}
