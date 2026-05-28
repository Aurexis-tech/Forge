// E2B-backed sandbox provider.
//
// E2B (https://e2b.dev/) is purpose-built for executing untrusted
// AI-generated code: each Sandbox.create() spins up a fresh isolated VM
// disconnected from the Forge host. We never pass platform secrets or DB
// URLs into the sandbox env; the runner only injects FORGE_MOCK_TOOLS and a
// few non-sensitive flags.
//
// SDK API surface is wrapped here so a future major bump only touches this
// file.

import type {
  ExecOptions,
  ExecResult,
  SandboxCreateOptions,
  SandboxFile,
  SandboxProvider,
} from '../provider';
import { withRetry } from '../../retry';

// The e2b SDK is imported dynamically so the heavy dep isn't pulled into
// bundles that don't actually run sandboxes (e.g. an unrelated route).
type Sandbox = {
  files: {
    write: (path: string, content: string) => Promise<unknown>;
  };
  commands: {
    run: (
      command: string,
      opts?: {
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        stdin?: string;
      },
    ) => Promise<{
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    }>;
  };
  kill: () => Promise<unknown>;
};

interface SandboxCtor {
  create: (opts?: {
    apiKey?: string;
    timeoutMs?: number;
    metadata?: Record<string, string>;
  }) => Promise<Sandbox>;
}

const WORKSPACE = '/home/user/agent';

export class E2BProvider implements SandboxProvider {
  readonly name = 'e2b';
  private sandbox: Sandbox | null = null;

  async create(opts: SandboxCreateOptions = {}): Promise<void> {
    // Prefer the BYOK-resolved key threaded in by the runner. Fall back to
    // the env var only when the caller didn't specify auth — keeps the
    // provider usable from harness / dev scripts.
    const apiKey = opts.auth?.apiKey ?? process.env.E2B_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[aurexis-forge] E2B_API_KEY is not set. Provision a key at https://e2b.dev/ ' +
          'or set SANDBOX_PROVIDER to a different supported provider.',
      );
    }

    // Dynamic import so the e2b package isn't pulled into route bundles
    // that don't actually exercise the sandbox.
    const mod = (await import('e2b')) as unknown as { Sandbox: SandboxCtor };
    const SandboxCls = mod.Sandbox;
    if (!SandboxCls || typeof SandboxCls.create !== 'function') {
      throw new Error(
        '[aurexis-forge] e2b SDK is installed but Sandbox.create is missing. ' +
          'The SDK API may have changed; update lib/engine/sandbox/providers/e2b.ts.',
      );
    }

    // Wrap the SDK call in withRetry: E2B occasionally returns 5xx
    // / network blips during sandbox boot. The classifier in
    // errors.ts marks HTTP 5xx/429 + network errors as transient;
    // permanent failures (auth, quota) bail out immediately.
    this.sandbox = await withRetry(
      () =>
        SandboxCls.create({
          apiKey,
          timeoutMs: opts.lifetimeMs ?? 5 * 60_000,
          metadata: opts.metadata,
        }),
      { maxAttempts: 3, baseDelayMs: 1000 },
    );

    // Ensure the workspace exists. Best-effort; failure is surfaced when
    // the first writeFiles call runs.
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
      // Retry on transient E2B network blips. The classifier marks
      // 5xx/429 + network errors retriable; a non-zero exit code
      // returns inside `result` and is NOT thrown, so it bypasses
      // the retry loop (exec semantics preserved).
      const result = await withRetry(
        () =>
          sbx.commands.run(command, {
            cwd: opts.cwd ?? WORKSPACE,
            envs: opts.env,
            timeoutMs: opts.timeoutMs,
            stdin: opts.stdin,
          }),
        { maxAttempts: 3, baseDelayMs: 500 },
      );
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
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

  private requireSandbox(): Sandbox {
    if (!this.sandbox) {
      throw new Error(
        '[aurexis-forge] E2BProvider used before create() — runner ordering bug.',
      );
    }
    return this.sandbox;
  }
}
