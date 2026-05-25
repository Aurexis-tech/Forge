// Strict-ordered sandbox runner.
//
//   create() → writeFiles() → install → build → smoke → destroy
//
// destroy() is ALWAYS called via finally, even if create() failed or any
// step threw. The sandbox is the security perimeter; outside this module,
// no one runs generated code.

import type { BuildPlan } from '../planner/schema';
import type { AgentSpec } from '../spec/schema';
import type { BuildFile, KeySource, SandboxLogLine, SandboxPhase } from '@/lib/types';
import { recordCost } from '../governance/ledger';
import { NeedsKeyError, resolveKey } from '../keys';
import {
  selectProvider,
  type ExecResult,
  type SandboxProvider,
} from './provider';
import { planSmokeTest } from './smoke';

// --- Tunable limits --------------------------------------------------------

const INSTALL_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 90_000;
const SANDBOX_LIFETIME_MS = 6 * 60_000;

// Hard cap on logs persisted per run (chars). A misbehaving build can emit a
// lot of output; we keep enough for a useful tail.
const LOG_BYTE_CAP = 64 * 1024;
// Per-log-line clamp so a single mega-line can't blow past the cap alone.
const LINE_CLAMP = 4 * 1024;

// --- Public API ------------------------------------------------------------

export interface RunnerInput {
  spec: AgentSpec;
  plan: BuildPlan;
  files: BuildFile[];
  // Governance scope for the cost ledger. The route is expected to have
  // already called assertAllowed() before reaching the runner; we record
  // actual compute_ms here after the sandbox is destroyed.
  governance?: {
    user_id: string | null;
    project_id?: string | null;
    ref?: string | null;
  };
}

export interface PhaseSummary {
  phase: SandboxPhase;
  status: 'ok' | 'failed' | 'skipped';
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
}

export interface RunnerResult {
  provider: string;
  build_ok: boolean;
  smoke_ok: boolean;
  passed: boolean;
  phases: PhaseSummary[];
  logs: SandboxLogLine[];
  error: string | null;
  duration_ms: number;
  iterations: number;
}

export async function runSandbox(input: RunnerInput): Promise<RunnerResult> {
  const start = Date.now();
  const logs: SandboxLogLine[] = [];
  let logBytes = 0;

  function record(
    phase: SandboxLogLine['phase'],
    stream: SandboxLogLine['stream'],
    message: string,
  ) {
    if (logBytes >= LOG_BYTE_CAP) return;
    const clamped = message.length > LINE_CLAMP ? message.slice(0, LINE_CLAMP) + '…' : message;
    const remaining = LOG_BYTE_CAP - logBytes;
    const piece = clamped.length > remaining ? clamped.slice(0, remaining) : clamped;
    logBytes += piece.length;
    logs.push({
      phase,
      stream,
      message: piece,
      at: new Date().toISOString(),
    });
  }

  function captureExec(phase: SandboxPhase, result: ExecResult) {
    if (result.stdout) {
      for (const line of result.stdout.split('\n')) {
        if (line) record(phase, 'stdout', line);
      }
    }
    if (result.stderr) {
      for (const line of result.stderr.split('\n')) {
        if (line) record(phase, 'stderr', line);
      }
    }
  }

  let provider: SandboxProvider | null = null;
  let providerName = process.env.SANDBOX_PROVIDER ?? 'e2b';
  let buildOk = false;
  let smokeOk = false;
  let error: string | null = null;
  let keySource: KeySource = 'platform';
  const phases: PhaseSummary[] = [];

  try {
    // --- BYOK: resolve the user's E2B key first ----------------------------
    // NeedsKeyError surfaces here when REQUIRE_BYOK is on and the user has
    // no key — bubble up so the route can show the connect-your-key gate.
    let resolved;
    try {
      resolved = await resolveKey(input.governance?.user_id ?? null, 'e2b');
    } catch (err) {
      if (err instanceof NeedsKeyError) throw err;
      throw err;
    }
    keySource = resolved.source;

    provider = selectProvider();
    providerName = provider.name;
    record('system', 'system', 'sandbox.create via ' + providerName + ' (' + keySource + ')');

    await provider.create({
      lifetimeMs: SANDBOX_LIFETIME_MS,
      metadata: { source: 'aurexis-forge' },
      auth: { apiKey: resolved.key },
    });

    // --- write files (scaffold + generated) ---
    record('system', 'system', 'sandbox.writeFiles ' + input.files.length);
    await provider.writeFiles(
      input.files.map((f) => ({ path: f.path, content: f.content })),
    );

    // --- write the smoke driver alongside the agent ---
    const smoke = planSmokeTest({ spec: input.spec, plan: input.plan });
    await provider.writeFiles([
      { path: 'forge_smoke.mjs', content: smoke.driverContent },
    ]);

    // --- 3. install ---
    record('system', 'system', 'phase.install');
    const installRes = await provider.exec(
      'npm install --no-audit --no-fund --loglevel=error',
      {
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: minimalEnv(),
      },
    );
    captureExec('install', installRes);
    phases.push(toPhase('install', installRes));
    if (installRes.timedOut || installRes.exitCode !== 0) {
      error = 'install failed: ' + describeFailure(installRes);
      // build + smoke are skipped — recorded as such so the UI shows them.
      phases.push(skippedPhase('build'));
      phases.push(skippedPhase('smoke'));
      return result();
    }

    // --- 4. real build / typecheck ---
    record('system', 'system', 'phase.build');
    const buildRes = await provider.exec('npx tsc --noEmit', {
      timeoutMs: BUILD_TIMEOUT_MS,
      env: minimalEnv(),
    });
    captureExec('build', buildRes);
    phases.push(toPhase('build', buildRes));
    if (buildRes.timedOut || buildRes.exitCode !== 0) {
      error = 'tsc build failed: ' + describeFailure(buildRes);
      phases.push(skippedPhase('smoke'));
      return result();
    }
    buildOk = true;

    // --- 5. smoke test (mock mode, no real network calls) ---
    record('system', 'system', 'phase.smoke (FORGE_MOCK_TOOLS=1)');
    const smokeRes = await provider.exec(smoke.command, {
      timeoutMs: smoke.timeoutMs,
      stdin: smoke.stdin,
      env: smokeEnv(),
    });
    captureExec('smoke', smokeRes);
    phases.push(toPhase('smoke', smokeRes));

    if (smokeRes.exitCode === 0 && !smokeRes.timedOut) {
      smokeOk = true;
    } else if (
      smoke.softTimeout &&
      smokeRes.timedOut &&
      !looksLikeError(smokeRes.stderr)
    ) {
      // Server-style trigger that never exits on its own. We accept this as
      // "module loaded cleanly for the duration of the timeout".
      smokeOk = true;
      record('smoke', 'system', 'soft-timeout accepted for server trigger');
    } else {
      error = 'smoke failed: ' + describeFailure(smokeRes);
    }

    return result();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    record('system', 'system', 'runner.error ' + error);
    return result();
  } finally {
    if (provider) {
      try {
        await provider.destroy();
        record('system', 'system', 'sandbox.destroyed');
      } catch (destroyErr) {
        // destroy() shouldn't throw, but defensive log if it does.
        const msg =
          destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
        record('system', 'system', 'sandbox.destroy.error ' + msg);
      }
    }
  }

  function result(): RunnerResult {
    const duration_ms = Date.now() - start;
    // Record sandbox compute cost regardless of pass/fail — we burned the
    // VM either way. key_source attributes whose fuel paid for it.
    // Failures inside recordCost don't throw.
    if (input.governance) {
      void recordCost({
        user_id: input.governance.user_id,
        project_id: input.governance.project_id ?? null,
        kind: 'sandbox',
        compute_ms: duration_ms,
        key_source: keySource,
        ref: input.governance.ref ?? 'sandbox.test',
      });
    }
    return {
      provider: providerName,
      build_ok: buildOk,
      smoke_ok: smokeOk,
      passed: buildOk && smokeOk,
      phases,
      logs,
      error,
      duration_ms,
      iterations: 0,
      // NOTE: self-heal loop would slot in here. The user prompt called it
      // optional; intentionally unimplemented for V1 to keep the security
      // perimeter unambiguous. When wired up, iterations++ per repair pass,
      // hard-capped at 2.
    };
  }
}

// --- Env hygiene -----------------------------------------------------------

// What we hand to the sandbox during install / build. Deliberately minimal:
// no platform secrets, no DB URL, nothing identifying the Forge host.
function minimalEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    CI: '1',
  };
}

function smokeEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    CI: '1',
    // The contract: every tool short-circuits to canned data when this is '1'.
    FORGE_MOCK_TOOLS: '1',
    // Informational only; tools should refuse real network even without it.
    FORGE_NETWORK_DISABLED: '1',
  };
}

// --- Helpers ---------------------------------------------------------------

function toPhase(phase: SandboxPhase, res: ExecResult): PhaseSummary {
  return {
    phase,
    status: res.timedOut || res.exitCode !== 0 ? 'failed' : 'ok',
    exit_code: res.exitCode,
    timed_out: res.timedOut,
    duration_ms: res.durationMs,
  };
}

function skippedPhase(phase: SandboxPhase): PhaseSummary {
  return {
    phase,
    status: 'skipped',
    exit_code: null,
    timed_out: false,
    duration_ms: 0,
  };
}

function describeFailure(res: ExecResult): string {
  if (res.timedOut) return 'timed out after ' + res.durationMs + 'ms';
  const tail = (res.stderr || res.stdout).split('\n').slice(-6).join('\n').trim();
  return 'exit ' + res.exitCode + (tail ? ' — ' + tail.slice(-400) : '');
}

function looksLikeError(stderr: string): boolean {
  if (!stderr) return false;
  return /error|exception|trace|cannot find module|enoent/i.test(stderr);
}
