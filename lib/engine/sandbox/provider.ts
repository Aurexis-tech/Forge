// Sandbox provider abstraction.
//
// The runner only ever talks to a SandboxProvider. Concrete providers are
// instantiated by `selectProvider()` based on env. This file defines the
// shape; the implementations live in ./providers/*.
//
// IMPORTANT — security contract every provider must uphold:
//
// - The sandbox is fresh, disposable, and isolated from the Forge host. No
//   shared filesystem, no shared process, no inherited env.
// - The provider receives ONLY the env values the runner explicitly passes
//   into exec(). It MUST NOT forward `process.env` from the Forge process.
// - destroy() is best-effort but the runner ALWAYS calls it in a finally
//   block. Providers must tolerate being destroyed before create() or
//   after create() failed.

/**
 * Outbound-network policy for a sandbox. When set, the provider MUST enforce it
 * at the INFRASTRUCTURE layer (host firewall), never inside the guest —
 * untrusted code in the sandbox must have no knob to disable it.
 *
 * `allowInternetAccess:false` denies ALL egress; `allowOut` then carves
 * exceptions (allow rules take precedence over the block). `allowInternetAccess:
 * false` with no `allowOut` = fully air-gapped.
 *
 * SECURITY: the allowlist is itself an exfiltration channel — every host you
 * permit is a host hostile code can phone out to, and domain rules implicitly
 * open DNS. Keep it MINIMAL. Prove egress is blocked from the CONFIG you set
 * here, NEVER from in-sandbox telemetry (the firewall can make a blocked TCP
 * connect look successful inside the guest).
 */
export interface SandboxEgress {
  /** false = deny all outbound, then allow only `allowOut`. */
  readonly allowInternetAccess: boolean;
  /** CIDR / IP / hostname allowlist (hostnames support `*.example.com`). */
  readonly allowOut?: ReadonlyArray<string>;
}

export interface SandboxCreateOptions {
  // Free-form labels for observability. Never used for code paths.
  metadata?: Record<string, string>;
  // Initial timeout for the whole sandbox lifetime. After this elapses the
  // provider may forcibly destroy the sandbox.
  lifetimeMs?: number;
  // BYOK: the provider API key to authenticate with. When provided, used
  // instead of any env-based key. The runner resolves this via resolveKey
  // before calling create(), so a missing key reads as NeedsKeyError up
  // top rather than a sandbox-level surprise.
  auth?: { apiKey: string };
  // Pinned sandbox template id. CPU/mem caps are baked into a template at BUILD
  // time (e2b sets resource limits at template-build, not at create), so a
  // hardened template is selected by id here. Undefined = the provider's
  // default base template.
  template?: string;
  // Outbound-network policy. Undefined = provider DEFAULT (today: internet ON —
  // the existing builder relies on this for `npm install` / `next build`, and
  // its smoke runs with mock tools so it makes no real calls). UNTRUSTED /
  // Sentinel runs MUST set this to deny-all + a minimal allowlist (see
  // lib/engine/sandbox/egress.ts). Left unset here, so this change adds the
  // capability without restricting the existing builder.
  egress?: SandboxEgress;
}

export interface SandboxFile {
  path: string;
  content: string;
}

export interface ExecOptions {
  // Hard wall-clock timeout in milliseconds. On timeout, the provider MUST
  // kill the running command and return { timedOut: true }.
  timeoutMs: number;
  // Working directory inside the sandbox. Defaults to the workspace.
  cwd?: string;
  // Env vars to inject. The provider MUST NOT add anything else.
  env?: Record<string, string>;
  // Stdin to feed to the command, or undefined for no stdin.
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export interface SandboxProvider {
  readonly name: string;

  // Create a fresh, isolated sandbox. Idempotent on the same instance is
  // not required; callers create a new provider per run.
  create(opts?: SandboxCreateOptions): Promise<void>;

  // Write the given files into the sandbox workspace (typically
  // `/home/user/agent` or similar). Overwrites existing files at the same
  // path. The base directory is provider-controlled and exposed via the
  // workspace() method.
  writeFiles(files: SandboxFile[]): Promise<void>;

  // The path commands should `cd` into to see the written files.
  workspace(): string;

  // Run a single shell command. Output is captured fully and returned.
  // The provider MUST enforce the timeout.
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;

  // Tear down the sandbox. Always safe to call; never throws.
  destroy(): Promise<void>;
}

import { E2BProvider } from './providers/e2b';
import { LocalDockerProvider } from './providers/local-docker';

export function selectProvider(): SandboxProvider {
  const which = (process.env.SANDBOX_PROVIDER ?? 'e2b').toLowerCase();
  if (which === 'e2b') return new E2BProvider();
  if (which === 'local-docker' || which === 'docker') {
    return new LocalDockerProvider();
  }
  throw new Error(
    "[aurexis-forge] Unknown SANDBOX_PROVIDER '" +
      which +
      "'. Supported: 'e2b', 'local-docker'.",
  );
}
