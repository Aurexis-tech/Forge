// Placeholder for a self-hosted Docker-backed sandbox.
//
// This provider is INTENTIONALLY STUBBED. Wiring it up correctly requires
// careful container hardening (rootless runtime, seccomp profile, no-net
// network namespace for the smoke phase, memory + CPU cgroups, read-only
// rootfs except for the workspace volume). Until that's done, calling any
// method throws a clear error so the operator can't accidentally route
// untrusted code through an under-hardened container.

import type {
  ExecOptions,
  ExecResult,
  SandboxCreateOptions,
  SandboxFile,
  SandboxProvider,
} from '../provider';

const NOT_IMPLEMENTED =
  '[aurexis-forge] LocalDockerProvider is stubbed. Set SANDBOX_PROVIDER=e2b ' +
  'until the hardened Docker driver is wired up.';

export class LocalDockerProvider implements SandboxProvider {
  readonly name = 'local-docker';

  async create(_opts?: SandboxCreateOptions): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  workspace(): string {
    return '/workspace';
  }

  async writeFiles(_files: SandboxFile[]): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async exec(_command: string, _opts: ExecOptions): Promise<ExecResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async destroy(): Promise<void> {
    // No-op: destroy must never throw and there's nothing allocated to clean up.
  }
}
