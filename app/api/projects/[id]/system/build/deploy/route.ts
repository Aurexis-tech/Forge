// POST /api/projects/[id]/system/build/deploy
//
// Phase 2 (Systems) deploy — deploys a pushed system bundle to Vercel.
// The system deploys as ONE UNIT — the orchestrator + entrypoint at
// `src/index.ts` is the deployable. REUSES the Phase 1
// `deployBuildToVercel` integration AS-IS; only the loader, the
// kind='system' status flips, the env-key aggregation, and the audit
// actions are system-specific.
//
// AUTHORIZATION GATE — the request body MUST include
// `{ "authorized": true }`. The Phase 1 path uses the same flag; we
// re-validate it here as defence in depth.
//
// SECRETS in the body — the route accepts a `secrets` map (key →
// value). Values are forwarded to Vercel's env API and dropped from
// memory; only KEY NAMES are persisted on deployments.env_keys.
//
// IMPORTANT — there is NO always_on / scheduled gate on the system
// deploy. The system deploys regardless of SystemSpec.triggers because
// runtime activation (for schedule-driven systems) is a separate
// future layer (P2-5b). The Phase 1 deploy route's always_on gate is
// agent-only.

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
  aggregateSystemEnvRequired,
  checkSystemDeployConcurrency,
  insertSystemDeploymentRow,
  loadPushedSystemBuildForDeploy,
  logSystemDeployAuthorized,
  logSystemDeployFailed,
  logSystemDeployed,
  markSystemBuildDeployFailed,
  markSystemBuildDeployed,
  markSystemBuildDeploying,
  markSystemDeploymentFailed,
  markSystemDeploymentReady,
} from '@/lib/engine/system/integrations/persistence';
import { getServerSupabase } from '@/lib/supabase';
import type { BuildPlan } from '@/lib/engine/planner/schema';

export const runtime = 'nodejs';
export const maxDuration = 600;

const SecretsSchema = z.record(z.string().min(1), z.string().max(8000));
const BodySchema = z.object({
  authorized: z.literal(true),
  secrets: SecretsSchema.optional(),
});

// System projects compile through the Phase 1 scaffold (Node + tsx)
// with the orchestrator as the entrypoint. We label the Vercel
// framework as 'node' so the build pipeline picks the right preset.
const SYSTEM_VERCEL_FRAMEWORK = 'node';

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
    return NextResponse.json({ error: ownership.error }, { status: ownership.status });
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
          'request body must include { "authorized": true } — the user must explicitly approve the system deploy',
      },
      { status: 403 },
    );
  }
  const incomingSecrets = parsed.data.secrets ?? {};

  const supabase = getServerSupabase();

  const guard = await loadPushedSystemBuildForDeploy(supabase, projectId);
  if ('error' in guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const { build, plan, files } = guard;

  // --- Concurrency --------------------------------------------------------
  const conc = await checkSystemDeployConcurrency(supabase, build.id);
  if ('error' in conc) {
    return NextResponse.json({ error: conc.error }, { status: conc.status });
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

  // --- Aggregate env: plan-derived + incoming secrets --------------------
  // The system has no `env_required` field; we derive one from the
  // union of node-level suggested_tools env_keys.
  const envRequired = aggregateSystemEnvRequired(plan);
  const envForVercel = mergeEnv(envRequired, incomingSecrets);
  const envKeysSet = envForVercel.map((e) => e.key);

  // --- Audit BEFORE acting ------------------------------------------------
  await logSystemDeployAuthorized(
    supabase,
    build,
    conn.row.account_login ?? null,
    envKeysSet,
    files.length,
  );

  // --- Mark in flight + insert deployments row ----------------------------
  await markSystemBuildDeploying(supabase, build.id);
  let depRow;
  try {
    depRow = await insertSystemDeploymentRow(supabase, build.id, envKeysSet);
  } catch (rowErr) {
    return NextResponse.json(
      {
        error:
          rowErr instanceof Error
            ? rowErr.message
            : 'failed to insert deployment row',
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
      framework: SYSTEM_VERCEL_FRAMEWORK,
      files,
      env: envForVercel,
    });

    await markSystemBuildDeployed(supabase, build.id, result.deployment_url);
    await markSystemDeploymentReady(supabase, depRow.id, {
      project_ref: result.project_ref,
      deployment_id: result.deployment_id,
      url: result.deployment_url,
      env_keys: result.env_keys_set,
    });
    await logSystemDeployed(supabase, build, {
      deployment_id: result.deployment_id,
      project_ref: result.project_ref,
      project_name: result.project_name,
      deploy_url: result.deployment_url,
      env_keys: result.env_keys_set,
    });

    return NextResponse.json({
      status: 'deployed',
      kind: 'system',
      url: result.deployment_url,
      project_ref: result.project_ref,
      deployment_id: result.deployment_id,
    });
  } catch (err) {
    const isV = err instanceof VercelDeployError;
    const message = err instanceof Error ? err.message : String(err);
    const logTail = isV ? (err as VercelDeployError).logTail ?? null : null;

    await markSystemBuildDeployFailed(supabase, build.id);
    await markSystemDeploymentFailed(supabase, depRow.id);
    await logSystemDeployFailed(supabase, build, message, logTail);

    return NextResponse.json(
      { error: message, log_tail: logTail },
      { status: 502 },
    );
  }
}

// --- Helpers ---------------------------------------------------------------

function parseTeamId(scopes: string | null): string | null {
  if (!scopes) return null;
  if (scopes.startsWith('team:')) return scopes.slice('team:'.length);
  return null;
}

function mergeEnv(
  envRequired: BuildPlan['env_required'],
  incomingSecrets: Record<string, string>,
): VercelEnvVar[] {
  const out: VercelEnvVar[] = [];
  const seen = new Set<string>();

  // First: every env declared by the aggregated env_required list,
  // using the user-supplied value if provided.
  for (const e of envRequired) {
    const value = incomingSecrets[e.key];
    if (e.secret && !value) {
      // A secret with no value is a UX flow bug; skip rather than
      // silently leak the slot. Vercel will likely surface a missing-
      // secret error at deploy, which is the correct signal.
      continue;
    }
    if (value === undefined) continue;
    seen.add(e.key);
    out.push({ key: e.key, value, secret: e.secret });
  }

  // Then: any extra secrets the user supplied that weren't in the
  // aggregated list. We assume secret semantics for safety.
  for (const [key, value] of Object.entries(incomingSecrets)) {
    if (seen.has(key)) continue;
    if (!value) continue;
    out.push({ key, value, secret: true });
  }

  return out;
}
