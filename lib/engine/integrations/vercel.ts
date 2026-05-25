// Server-only Vercel deploy adapter.
//
//   ensureProject → wipe + set env → upload files → create deployment → poll
//
// Tokens, env values, and secrets only ever live in memory inside this
// module. The deployments row stores ONLY key names, never values.
//
// NOTE: the URL Vercel returns is publicly addressable by design. If you
// need per-agent access control, add it at the agent-handler level
// (verify a header / signed payload) — this layer does not.

import { createHash } from 'node:crypto';
import type { BuildFile } from '@/lib/types';
import { deriveRepoName } from './github-name';

export class VercelDeployError extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  readonly logTail?: string;
  constructor(
    message: string,
    opts?: { status?: number; cause?: unknown; logTail?: string },
  ) {
    super(message);
    this.name = 'VercelDeployError';
    this.status = opts?.status;
    this.cause = opts?.cause;
    this.logTail = opts?.logTail;
  }
}

const VERCEL_API = 'https://api.vercel.com';
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 8 * 60_000;

export interface VercelEnvVar {
  key: string;
  value: string;
  secret: boolean;
}

export interface VercelDeployInput {
  token: string;
  // Optional team scope. PATs work without a team; OAuth integrations supply
  // a team_id we propagate as ?teamId=.
  teamId?: string | null;
  projectName: string;
  framework: string;
  files: BuildFile[];
  env: VercelEnvVar[];
}

export interface VercelDeployOutput {
  project_ref: string; // Vercel project id
  project_name: string;
  deployment_id: string;
  deployment_url: string; // canonical https url
  env_keys_set: string[];
  ready_state: 'READY';
}

const MAX_FILES = 500;

export function deriveVercelProjectName(projectName: string): string {
  // Project names share GitHub's rules closely enough that we reuse the
  // sanitiser. Vercel additionally caps at 100 chars and disallows trailing
  // underscores; the GitHub helper already covers both.
  return deriveRepoName(projectName);
}

export async function deployBuildToVercel(
  input: VercelDeployInput,
): Promise<VercelDeployOutput> {
  if (input.files.length === 0) {
    throw new VercelDeployError('build has no files to deploy');
  }
  if (input.files.length > MAX_FILES) {
    throw new VercelDeployError(
      'build has ' + input.files.length + ' files; refusing to deploy > ' + MAX_FILES,
    );
  }

  const projectName = deriveVercelProjectName(input.projectName);

  // --- 1. Ensure project exists --------------------------------------------
  const project = await ensureProject(input.token, input.teamId, projectName);
  const projectId = project.id;

  // --- 2. Wipe + set env vars (so retries don't carry stale values) -------
  const envKeysSet: string[] = [];
  if (input.env.length > 0) {
    await replaceProjectEnv(input.token, input.teamId, projectId, input.env);
    for (const e of input.env) envKeysSet.push(e.key);
  }

  // --- 3. Upload files -----------------------------------------------------
  const manifest = await uploadFiles(input.token, input.teamId, input.files);

  // --- 4. Create production deployment ------------------------------------
  const deployment = await createDeployment(
    input.token,
    input.teamId,
    {
      name: projectName,
      projectId,
      framework: normaliseFramework(input.framework),
      manifest,
    },
  );

  // --- 5. Poll until READY or ERROR ----------------------------------------
  const final = await pollDeployment(
    input.token,
    input.teamId,
    deployment.id,
  );

  return {
    project_ref: projectId,
    project_name: projectName,
    deployment_id: deployment.id,
    deployment_url: 'https://' + final.url,
    env_keys_set: envKeysSet,
    ready_state: 'READY',
  };
}

// --- API helpers -----------------------------------------------------------

interface VercelProject {
  id: string;
  name: string;
}

async function ensureProject(
  token: string,
  teamId: string | null | undefined,
  projectName: string,
): Promise<VercelProject> {
  const team = teamQuery(teamId);
  const get = await fetch(
    VERCEL_API + '/v9/projects/' + encodeURIComponent(projectName) + team,
    { headers: authHeaders(token) },
  );
  if (get.ok) {
    const data = (await get.json()) as VercelProject;
    return data;
  }
  if (get.status !== 404) {
    throw await toApiError(get, 'project lookup');
  }
  const create = await fetch(VERCEL_API + '/v9/projects' + team, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ name: projectName, framework: null }),
  });
  if (!create.ok) {
    throw await toApiError(create, 'project create');
  }
  return (await create.json()) as VercelProject;
}

interface ExistingEnv {
  id: string;
  key: string;
}

async function replaceProjectEnv(
  token: string,
  teamId: string | null | undefined,
  projectId: string,
  env: VercelEnvVar[],
): Promise<void> {
  const team = teamQuery(teamId);

  // Pull the current env list so we can delete stale entries.
  const list = await fetch(
    VERCEL_API + '/v10/projects/' + projectId + '/env' + team,
    { headers: authHeaders(token) },
  );
  let existing: ExistingEnv[] = [];
  if (list.ok) {
    const data = (await list.json()) as { envs?: ExistingEnv[] };
    existing = data.envs ?? [];
  }

  const toReplace = new Set(env.map((e) => e.key));
  for (const ev of existing) {
    if (toReplace.has(ev.key)) {
      const del = await fetch(
        VERCEL_API +
          '/v10/projects/' +
          projectId +
          '/env/' +
          ev.id +
          team,
        { method: 'DELETE', headers: authHeaders(token) },
      );
      if (!del.ok && del.status !== 404) {
        throw await toApiError(del, 'env delete ' + ev.key);
      }
    }
  }

  for (const e of env) {
    if (!e.value) {
      // Skip empty values; we'd be creating a useless empty env.
      continue;
    }
    const create = await fetch(
      VERCEL_API + '/v10/projects/' + projectId + '/env' + team,
      {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({
          key: e.key,
          value: e.value,
          type: e.secret ? 'encrypted' : 'plain',
          target: ['production', 'preview', 'development'],
        }),
      },
    );
    if (!create.ok) {
      // 409 means another env with this key still exists somewhere; surface
      // it because we just tried to delete it.
      throw await toApiError(create, 'env set ' + e.key);
    }
  }
}

interface FileEntry {
  file: string;
  sha: string;
  size: number;
}

async function uploadFiles(
  token: string,
  teamId: string | null | undefined,
  files: BuildFile[],
): Promise<FileEntry[]> {
  const team = teamQuery(teamId);
  const manifest: FileEntry[] = [];
  for (const f of files) {
    const buf = Buffer.from(f.content, 'utf8');
    const sha = createHash('sha1').update(buf).digest('hex');
    const upload = await fetch(VERCEL_API + '/v2/files' + team, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-length': String(buf.length),
        'x-vercel-digest': sha,
        'content-type': 'application/octet-stream',
        'user-agent': 'aurexis-forge',
      },
      body: buf,
    });
    if (!upload.ok && upload.status !== 200) {
      throw await toApiError(upload, 'upload ' + f.path);
    }
    manifest.push({ file: f.path, sha, size: buf.length });
  }
  return manifest;
}

interface CreatedDeployment {
  id: string;
}

async function createDeployment(
  token: string,
  teamId: string | null | undefined,
  args: {
    name: string;
    projectId: string;
    framework: string | null;
    manifest: FileEntry[];
  },
): Promise<CreatedDeployment> {
  const team = teamQuery(teamId);
  const create = await fetch(VERCEL_API + '/v13/deployments' + team, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({
      name: args.name,
      project: args.projectId,
      files: args.manifest,
      target: 'production',
      projectSettings: args.framework ? { framework: args.framework } : {},
    }),
  });
  if (!create.ok) {
    throw await toApiError(create, 'create deployment');
  }
  const data = (await create.json()) as { id?: string };
  if (!data.id) {
    throw new VercelDeployError('create deployment response missing id');
  }
  return { id: data.id };
}

type ReadyState =
  | 'INITIALIZING'
  | 'QUEUED'
  | 'BUILDING'
  | 'READY'
  | 'ERROR'
  | 'CANCELED';

interface DeploymentStatus {
  readyState: ReadyState;
  url: string; // host only, no scheme
  errorMessage?: string;
}

async function pollDeployment(
  token: string,
  teamId: string | null | undefined,
  deploymentId: string,
): Promise<DeploymentStatus> {
  const team = teamQuery(teamId);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: DeploymentStatus | null = null;

  while (Date.now() < deadline) {
    const res = await fetch(
      VERCEL_API + '/v13/deployments/' + deploymentId + team,
      { headers: authHeaders(token) },
    );
    if (!res.ok) {
      throw await toApiError(res, 'poll deployment');
    }
    const data = (await res.json()) as DeploymentStatus;
    last = data;

    if (data.readyState === 'READY') return data;
    if (data.readyState === 'ERROR' || data.readyState === 'CANCELED') {
      const tail = await fetchBuildLogTail(token, teamId, deploymentId).catch(
        () => '',
      );
      throw new VercelDeployError(
        'deployment ' + data.readyState + (data.errorMessage ? ': ' + data.errorMessage : ''),
        { logTail: tail || undefined },
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const tail = await fetchBuildLogTail(token, teamId, deploymentId).catch(
    () => '',
  );
  throw new VercelDeployError(
    'deployment polling timed out after ' + POLL_TIMEOUT_MS + 'ms (last state: ' + (last?.readyState ?? 'unknown') + ')',
    { logTail: tail || undefined },
  );
}

interface BuildLogEntry {
  text?: string;
  payload?: { text?: string };
}

async function fetchBuildLogTail(
  token: string,
  teamId: string | null | undefined,
  deploymentId: string,
): Promise<string> {
  const team = teamQuery(teamId);
  // The v2 events endpoint returns build/runtime events. We pull the most
  // recent ~50 lines for a useful failure summary in the UI.
  const res = await fetch(
    VERCEL_API + '/v2/deployments/' + deploymentId + '/events' + team + (team ? '&' : '?') + 'limit=50&direction=backward',
    { headers: authHeaders(token) },
  );
  if (!res.ok) return '';
  const data = (await res.json()) as BuildLogEntry[] | { events?: BuildLogEntry[] };
  const events: BuildLogEntry[] = Array.isArray(data) ? data : data.events ?? [];
  const lines = events
    .map((e) => (e.text ?? e.payload?.text ?? '').trim())
    .filter((s) => s.length > 0)
    .slice(-50);
  // The events endpoint returns newest-first when direction=backward; reverse
  // so the tail reads top-to-bottom in time order.
  lines.reverse();
  return lines.join('\n').slice(-4000);
}

// --- Tiny helpers ----------------------------------------------------------

function authHeaders(token: string, json = false): Record<string, string> {
  const base: Record<string, string> = {
    authorization: 'Bearer ' + token,
    'user-agent': 'aurexis-forge',
    accept: 'application/json',
  };
  if (json) base['content-type'] = 'application/json';
  return base;
}

function teamQuery(teamId: string | null | undefined): string {
  return teamId ? '?teamId=' + encodeURIComponent(teamId) : '';
}

function normaliseFramework(framework: string): string | null {
  const f = framework.toLowerCase().trim();
  // Map our plan vocabulary to Vercel's framework slugs. Unknown values fall
  // through to autodetect (null).
  if (f.includes('next')) return 'nextjs';
  if (f.includes('node')) return null;
  if (f.includes('hono')) return null;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function toApiError(res: Response, context: string): Promise<VercelDeployError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string }; message?: string };
    detail = body.error?.message ?? body.message ?? '';
  } catch {
    detail = await res.text().catch(() => '');
  }
  return new VercelDeployError(
    context + ': HTTP ' + res.status + (detail ? ' — ' + detail.slice(0, 400) : ''),
    { status: res.status },
  );
}
