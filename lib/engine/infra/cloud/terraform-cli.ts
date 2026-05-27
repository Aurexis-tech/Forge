// TerraformCliProvider — concrete CloudProvider that shells out to
// `terraform plan -json` against the user's cloud, with the user's
// decrypted cloud credentials loaded into the child process env.
//
// IMPORTANT: this file's network/disk effects are GATED entirely by
// the route layer's connection check + governance pre-flight. The
// tests stub `selectCloudProvider` to return a scripted stub before
// any route call; this module is never exercised in unit/dry-run
// tests. It exists so the production code path has a concrete
// implementation to point at.
//
// SECURITY:
//   - `creds.env` is spread into the CHILD process's env only. The
//     parent process's `process.env` is NEVER mutated.
//   - The credentials reference is dropped from the provider's
//     scope (`creds = null as any` at the end) so a future stack
//     inspection can't snapshot them by accident.
//   - The raw JSON output is sanitised via sanitizeJsonForLog BEFORE
//     it reaches the return value, so the persisted plan_diff never
//     carries a secret-shaped string.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type {
  CloudApplyInput,
  CloudApplyResult,
  CloudDestroyInput,
  CloudDestroyResult,
  CloudPlanInput,
  CloudProvider,
  InfraPlanDiff,
  PlanResult,
  PlannedResource,
  ResourceAction,
} from './provider';
import { sanitizeJsonForLog } from './provider';

const PLAN_TIMEOUT_MS = 5 * 60_000;

export class TerraformCliError extends Error {
  readonly logTail?: string;
  constructor(message: string, opts?: { logTail?: string }) {
    super(message);
    this.name = 'TerraformCliError';
    this.logTail = opts?.logTail;
  }
}

export class TerraformCliProvider implements CloudProvider {
  readonly kind = 'terraform_cli' as const;
  readonly name = 'terraform-cli';

  async plan(input: CloudPlanInput): Promise<PlanResult> {
    let dir: string | null = null;
    let creds: CloudPlanInput['credentials'] | null = input.credentials;
    try {
      dir = input.workdirOverride ?? (await mkdtemp(join(tmpdir(), 'forge-tf-')));
      for (const f of input.files) {
        const dest = join(dir, f.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.content, 'utf8');
      }

      await run('terraform', ['init', '-input=false', '-no-color'], {
        cwd: dir,
        envExtras: creds.env,
      });
      // Save the plan artifact to disk so the apply step can pass
      // it back to `terraform apply` verbatim. -out= is what locks
      // confirm-vs-apply parity.
      const artifactPath = join(dir, 'aurexis.tfplan');
      const planOutput = await run(
        'terraform',
        [
          'plan',
          '-no-color',
          '-input=false',
          '-detailed-exitcode',
          '-out=' + artifactPath,
          '-json',
        ],
        {
          cwd: dir,
          envExtras: creds.env,
          // -detailed-exitcode returns 0 = no changes, 1 = error,
          // 2 = changes present. The runner treats 2 as success.
          allowedExitCodes: [0, 2],
        },
      );
      const artifactBuf = await readFile(artifactPath);
      const artifactB64 = artifactBuf.toString('base64');
      // Drop the credentials reference now — we no longer need it.
      creds = null;

      return {
        diff: parsePlanJson(planOutput),
        plan_artifact_b64: artifactB64,
      };
    } finally {
      if (dir && !input.workdirOverride) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      creds = null;
    }
  }

  async apply(input: CloudApplyInput): Promise<CloudApplyResult> {
    let dir: string | null = null;
    let creds: CloudApplyInput['credentials'] | null = input.credentials;
    try {
      dir = input.workdirOverride ?? (await mkdtemp(join(tmpdir(), 'forge-tf-')));
      for (const f of input.files) {
        const dest = join(dir, f.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.content, 'utf8');
      }
      // Write the saved plan artifact verbatim.
      const artifactPath = join(dir, 'aurexis.tfplan');
      await writeFile(
        artifactPath,
        Buffer.from(input.planArtifactB64, 'base64'),
      );

      await run('terraform', ['init', '-input=false', '-no-color'], {
        cwd: dir,
        envExtras: creds.env,
        signal: input.signal,
      });

      let aborted = false;
      let errorMessage: string | null = null;
      try {
        await run(
          'terraform',
          [
            'apply',
            '-no-color',
            '-input=false',
            '-auto-approve=false',
            '-json',
            artifactPath,
          ],
          {
            cwd: dir,
            envExtras: creds.env,
            signal: input.signal,
          },
        );
      } catch (err) {
        if (err instanceof TerraformCliError && err.message.includes('aborted')) {
          aborted = true;
        } else {
          errorMessage =
            err instanceof Error ? err.message : 'apply failed';
        }
      }

      // Capture state regardless of outcome — partial state is
      // valuable for rollback.
      let state: string | null = null;
      let partial = false;
      try {
        const stateBuf = await readFile(join(dir, 'terraform.tfstate'));
        state = stateBuf.toString('utf8');
        partial = aborted || errorMessage != null;
      } catch {
        state = null;
      }

      let outputs: Record<string, unknown> = {};
      if (!aborted && !errorMessage) {
        try {
          const out = await run(
            'terraform',
            ['output', '-json', '-no-color'],
            { cwd: dir, envExtras: creds.env },
          );
          const parsed = JSON.parse(out) as Record<
            string,
            { value?: unknown }
          >;
          const flat: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(parsed ?? {})) {
            flat[k] = v?.value ?? null;
          }
          outputs = sanitizeJsonForLog(flat) as Record<string, unknown>;
        } catch {
          outputs = {};
        }
      }

      creds = null;
      return {
        ok: !aborted && errorMessage == null,
        aborted,
        resources_added: 0,
        resources_changed: 0,
        resources_destroyed: 0,
        state,
        partial_state: partial,
        outputs,
        error: errorMessage,
      };
    } finally {
      if (dir && !input.workdirOverride) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      creds = null;
    }
  }

  async destroy(input: CloudDestroyInput): Promise<CloudDestroyResult> {
    let dir: string | null = null;
    let creds: CloudDestroyInput['credentials'] | null = input.credentials;
    let state: string | null = input.state;
    try {
      dir = input.workdirOverride ?? (await mkdtemp(join(tmpdir(), 'forge-tf-')));
      for (const f of input.files) {
        const dest = join(dir, f.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.content, 'utf8');
      }
      await writeFile(join(dir, 'terraform.tfstate'), state, 'utf8');
      // Drop the parent's reference to the state plaintext as soon
      // as it's on disk in the child's workdir.
      state = null;

      await run('terraform', ['init', '-input=false', '-no-color'], {
        cwd: dir,
        envExtras: creds.env,
        signal: input.signal,
      });

      let aborted = false;
      let errorMessage: string | null = null;
      try {
        await run(
          'terraform',
          [
            'destroy',
            '-auto-approve',
            '-no-color',
            '-input=false',
            '-json',
          ],
          {
            cwd: dir,
            envExtras: creds.env,
            signal: input.signal,
          },
        );
      } catch (err) {
        if (err instanceof TerraformCliError && err.message.includes('aborted')) {
          aborted = true;
        } else {
          errorMessage =
            err instanceof Error ? err.message : 'destroy failed';
        }
      }

      let finalState: string | null = null;
      let partial = aborted || errorMessage != null;
      try {
        const stateBuf = await readFile(join(dir, 'terraform.tfstate'));
        finalState = stateBuf.toString('utf8');
      } catch {
        finalState = null;
      }

      creds = null;
      return {
        ok: !aborted && errorMessage == null,
        aborted,
        resources_destroyed: 0,
        state: finalState,
        partial_state: partial,
        error: errorMessage,
      };
    } finally {
      if (dir && !input.workdirOverride) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      creds = null;
      state = null;
    }
  }
}

// ---------------------------------------------------------------------------
// terraform plan -json emits a STREAM of newline-delimited JSON
// objects, one per planned event. We collect them, then extract the
// 'planned_change' + 'change_summary' events into our structured diff.
// ---------------------------------------------------------------------------

interface RawPlanEvent {
  type?: string;
  message?: string;
  change?: {
    resource?: { addr?: string; resource_type?: string };
    action?: string;
  };
  changes?: {
    add?: number;
    change?: number;
    remove?: number;
  };
  terraform?: string;
  // The structured 'planned_change' shape:
  resource?: { addr?: string; resource_type?: string };
  action?: string;
}

function parsePlanJson(stdoutText: string): InfraPlanDiff {
  // Sanitise BEFORE parsing so any secret-shaped text in raw output
  // is scrubbed before it influences the structured diff.
  const events: RawPlanEvent[] = [];
  for (const line of stdoutText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      events.push(sanitizeJsonForLog(parsed) as RawPlanEvent);
    } catch {
      // Non-JSON lines (provider warnings) — drop.
    }
  }

  const resources: PlannedResource[] = [];
  let tfVersion = 'unknown';
  let create = 0;
  let change = 0;
  let replace = 0;
  let destroy = 0;
  const providerMeta: string[] = [];

  for (const evt of events) {
    if (evt.type === 'version' && typeof evt.terraform === 'string') {
      tfVersion = evt.terraform;
      continue;
    }
    if (evt.type === 'planned_change' && evt.change) {
      const addr = evt.change.resource?.addr ?? '';
      const resourceType = evt.change.resource?.resource_type ?? '';
      const action = coalesceAction(evt.change.action);
      if (!addr) continue;
      const module = moduleFromAddress(addr);
      resources.push({
        address: addr,
        type: resourceType,
        module,
        action,
      });
      if (action === 'create') create++;
      else if (action === 'change') change++;
      else if (action === 'replace') replace++;
      else if (action === 'destroy') destroy++;
      continue;
    }
    if (evt.type === 'provider_metadata' && typeof evt.message === 'string') {
      providerMeta.push(evt.message.slice(0, 200));
    }
  }

  return {
    resources,
    create_count: create,
    change_count: change,
    replace_count: replace,
    destroy_count: destroy,
    destructive: change + replace + destroy > 0,
    terraform_version: tfVersion,
    provider_metadata: providerMeta,
  };
}

function coalesceAction(s: string | undefined): ResourceAction {
  switch (s) {
    case 'create':
      return 'create';
    case 'update':
    case 'modify':
      return 'change';
    case 'replace':
      return 'replace';
    case 'delete':
    case 'destroy':
      return 'destroy';
    case 'noop':
    case 'read':
      return 'no-op';
    default:
      // Defensive — anything we don't recognise gets classified as
      // a CHANGE so the gate treats it as destructive. Better to
      // over-classify than under-classify here.
      return 'change';
  }
}

function moduleFromAddress(addr: string): string | null {
  // "module.<id>.aws_db_instance.this" → "<id>"
  const m = /^module\.([a-z][a-z0-9_]*)\./.exec(addr);
  return m ? m[1] ?? null : null;
}

// ---------------------------------------------------------------------------
// Minimal child-process runner — terraform's the only command this
// module shells out to. NEVER pass shell-expanded strings; spawn the
// binary with an argv array. PATH-resolved.
// ---------------------------------------------------------------------------

interface RunOptions {
  cwd: string;
  envExtras: Record<string, string>;
  allowedExitCodes?: ReadonlyArray<number>;
  // Phase 4-5b — when set, an aborted signal SIGINTs the child so
  // terraform can finish the in-flight resource cleanly before
  // stopping. The route layer attaches a kill-switch watcher to this
  // signal.
  signal?: AbortSignal;
}

async function run(
  bin: string,
  args: ReadonlyArray<string>,
  opts: RunOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const allowed = opts.allowedExitCodes ?? [0];
    let stdout = '';
    let stderr = '';
    // Build the env explicitly — typing as NodeJS.ProcessEnv via a
    // cast so we don't have to satisfy every standard ProcessEnv key.
    const childEnv = {
      PATH: process.env.PATH ?? '',
      ...opts.envExtras,
    } as unknown as NodeJS.ProcessEnv;
    const child: ChildProcessWithoutNullStreams = spawn(bin, [...args], {
      cwd: opts.cwd,
      env: childEnv,
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new TerraformCliError('terraform ' + args[0] + ' timed out', {
          logTail: stderr.slice(-2000),
        }),
      );
    }, PLAN_TIMEOUT_MS);
    // Mid-flight kill switch hook. SIGINT lets terraform finish the
    // in-flight resource cleanly before stopping; on slow paths a
    // follow-up SIGKILL ensures we don't hang past 30s.
    let abortKickTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      child.kill('SIGINT');
      abortKickTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 30_000);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new TerraformCliError('terraform spawn error: ' + err.message));
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (abortKickTimer) clearTimeout(abortKickTimer);
      if (opts.signal?.aborted) {
        return reject(
          new TerraformCliError(
            'terraform ' + args[0] + ' aborted by kill switch',
            { logTail: stderr.slice(-2000) },
          ),
        );
      }
      const exit = code ?? -1;
      if (!allowed.includes(exit)) {
        return reject(
          new TerraformCliError(
            'terraform ' + args[0] + ' exited ' + exit,
            { logTail: stderr.slice(-2000) },
          ),
        );
      }
      resolve(stdout);
    });
  });
}
