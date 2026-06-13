// E2B-backed sandbox provider (e2b SDK 2.x).
//
// E2B (https://e2b.dev/) runs each sandbox in a fresh, isolated Firecracker
// microVM disconnected from the Forge host. We never pass platform secrets or
// DB URLs into the sandbox env; the runner only injects FORGE_MOCK_TOOLS and a
// few non-sensitive flags.
//
// The e2b SDK surface is wrapped here so a future major bump only touches this
// file. MIGRATION 1.x -> 2.x — two behavioural breaking changes the runners
// depend on, handled here so nothing upstream changes:
//   1. `commands.run` now THROWS `CommandExitError` on a non-zero exit code
//      (1.x returned it inside the result). The runners read `exitCode` to
//      decide pass/fail (a failed build, a failed test, an isolation leak), so
//      we CATCH the error — it IS a CommandResult — and return its
//      {stdout, stderr, exitCode}. A non-zero exit must stay a RESULT, not a
//      thrown error, or every failing command misreports as a generic crash.
//   2. `commands.run`'s `stdin` option is now a BOOLEAN (keep-stdin-open), not
//      a string. To FEED a string (the chat-triggered agent smoke does this) we
//      run in the background with `stdin: true`, send the data, signal EOF, then
//      `wait()` for the result.
// New in 2.x and threaded through: `allowInternetAccess` + `network.allowOut`
// (egress firewall) and `template` (pinned hardened template) on create().

import type {
  ExecOptions,
  ExecResult,
  SandboxCreateOptions,
  SandboxFile,
  SandboxProvider,
} from '../provider';
// Type-only import — erased at compile time, so the heavy e2b dep is NOT pulled
// into bundles that don't run sandboxes. The runtime value comes from the
// dynamic import inside create().
import type { Sandbox as E2BSandbox, SandboxOpts } from 'e2b';
import { withRetry } from '../../retry';

const WORKSPACE = '/home/user/agent';

/**
 * PURE translation: Forge `SandboxCreateOptions` -> e2b `SandboxOpts`. Exported
 * so a hermetic unit test can PROVE the egress + resource config from the config
 * itself (never from in-sandbox observation — see SandboxEgress security note).
 */
export function buildE2bCreateOptions(
  opts: SandboxCreateOptions,
  apiKey: string,
): SandboxOpts {
  const e2bOpts: SandboxOpts = {
    apiKey,
    timeoutMs: opts.lifetimeMs ?? 5 * 60_000,
    metadata: opts.metadata,
  };
  if (opts.template) {
    e2bOpts.template = opts.template;
  }
  if (opts.egress) {
    const allowOut = opts.egress.allowOut;
    if (allowOut && allowOut.length > 0) {
      // Deny ALL outbound, then allow only the allowlist (allow rules take
      // precedence over deny). e2b's API REQUIRES `denyOut` to include
      // ALL_TRAFFIC ('0.0.0.0/0') whenever `allowOut` is set — `allowInternet
      // Access:false` alone is REJECTED at create() with a 400 ("must include
      // ALL_TRAFFIC in deny out"). Verified against the LIVE e2b API, not just
      // the type docs.
      e2bOpts.network = {
        denyOut: ({ allTraffic }) => [allTraffic],
        allowOut: [...allowOut],
      };
    } else if (!opts.egress.allowInternetAccess) {
      // Full air-gap — no allowlist, so block all outbound with the coarse flag.
      e2bOpts.allowInternetAccess = false;
    }
  }
  return e2bOpts;
}

export class E2BProvider implements SandboxProvider {
  readonly name = 'e2b';
  private sandbox: E2BSandbox | null = null;

  async create(opts: SandboxCreateOptions = {}): Promise<void> {
    // Prefer the BYOK-resolved key threaded in by the runner. Fall back to the
    // env var only when the caller didn't specify auth.
    const apiKey = opts.auth?.apiKey ?? process.env.E2B_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[aurexis-forge] E2B_API_KEY is not set. Provision a key at https://e2b.dev/ ' +
          'or set SANDBOX_PROVIDER to a different supported provider.',
      );
    }

    // Dynamic import so the e2b package isn't pulled into route bundles that
    // don't actually exercise the sandbox.
    const mod = (await import('e2b')) as { Sandbox: typeof E2BSandbox };
    const SandboxCls = mod.Sandbox;
    if (!SandboxCls || typeof SandboxCls.create !== 'function') {
      throw new Error(
        '[aurexis-forge] e2b SDK is installed but Sandbox.create is missing. ' +
          'The SDK API may have changed; update lib/engine/sandbox/providers/e2b.ts.',
      );
    }

    // Retry transient E2B 5xx / network blips during sandbox boot; permanent
    // failures (auth, quota) bail out immediately via the classifier.
    this.sandbox = await withRetry(
      () => SandboxCls.create(buildE2bCreateOptions(opts, apiKey)),
      { maxAttempts: 3, baseDelayMs: 1000 },
    );

    // Ensure the workspace exists. Best-effort; failure surfaces on first write.
    await this.execInternal('mkdir -p ' + WORKSPACE, {
      timeoutMs: 10_000,
      cwd: '/',
    }).catch(() => undefined);
  }

  workspace(): string {
    return WORKSPACE;
  }

  async writeFiles(files: SandboxFile[]): Promise<void> {
    const sbx = this.requireSandbox();
    for (const f of files) {
      const full = WORKSPACE + '/' + f.path.replace(/^\/+/, '');
      await sbx.files.write(full, f.content);
    }
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    return this.execInternal(command, opts);
  }

  private async execInternal(
    command: string,
    opts: ExecOptions,
  ): Promise<ExecResult> {
    const sbx = this.requireSandbox();
    const start = Date.now();
    try {
      // runCommand resolves a non-zero exit into a RESULT (not a throw), so the
      // retry only fires on genuine transient errors — a failed build must not
      // be retried 3x.
      const result = await withRetry(() => runCommand(sbx, command, opts), {
        maxAttempts: 3,
        baseDelayMs: 500,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: false,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut =
        /timeout|timed.?out/i.test(message) ||
        Date.now() - start >= opts.timeoutMs;
      return {
        stdout: '',
        stderr: message,
        exitCode: timedOut ? 124 : 1,
        timedOut,
        durationMs: Date.now() - start,
      };
    }
  }

  async destroy(): Promise<void> {
    if (!this.sandbox) return;
    try {
      await this.sandbox.kill();
    } catch {
      // Always swallow — destroy must never throw.
    } finally {
      this.sandbox = null;
    }
  }

  private requireSandbox(): E2BSandbox {
    if (!this.sandbox) {
      throw new Error(
        '[aurexis-forge] E2BProvider used before create() — runner ordering bug.',
      );
    }
    return this.sandbox;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Run a command, normalising the two 2.x breaking changes. A non-zero exit
// (CommandExitError) is returned as a RESULT; only genuine transient errors are
// re-thrown (so the caller's withRetry handles them, NOT a failed command).
async function runCommand(
  sbx: E2BSandbox,
  command: string,
  opts: ExecOptions,
): Promise<RunResult> {
  const base = { cwd: opts.cwd ?? WORKSPACE, envs: opts.env, timeoutMs: opts.timeoutMs };
  try {
    if (opts.stdin !== undefined) {
      // 2.x: stdin is a boolean (keep-open). To feed a string we background the
      // command with stdin open, send the data, signal EOF, then wait.
      const handle = await sbx.commands.run(command, {
        ...base,
        background: true,
        stdin: true,
      });
      try {
        await handle.sendStdin(opts.stdin);
        await handle.closeStdin();
      } catch {
        // Best-effort: if the feed fails, still wait for whatever the command did.
      }
      const result = await handle.wait();
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    }
    const result = await sbx.commands.run(command, base);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } catch (err) {
    // CommandExitError IS a CommandResult (stdout/stderr/exitCode) — a non-zero
    // exit, NOT a transport failure. Return it so the runner reads the real exit
    // code. Anything else (network/timeout) re-throws for the retry loop.
    const asResult = commandResultFromError(err);
    if (asResult) return asResult;
    throw err;
  }
}

// Structural detection of e2b's CommandExitError without importing the e2b value
// at module load. It carries numeric exitCode + stdout/stderr.
function commandResultFromError(err: unknown): RunResult | null {
  if (
    err &&
    typeof err === 'object' &&
    'exitCode' in err &&
    typeof (err as { exitCode: unknown }).exitCode === 'number' &&
    'stdout' in err &&
    'stderr' in err
  ) {
    const e = err as { exitCode: number; stdout?: unknown; stderr?: unknown };
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
      exitCode: e.exitCode,
    };
  }
  return null;
}
