// Aurexis Forge — Phase 2 (Systems) sandbox runner.
//
// Strict-ordered:
//   create() → writeFiles() → install → build → smoke
//     [if smoke failed AND a single failing node is identifiable]
//     → regenerate that node's module via the P2-3 generator
//     → re-write file → build → smoke (one bounded retry)
//   → destroy()
//
// destroy() is ALWAYS called in finally, even if create() failed or
// any step threw. Reuses the Phase 1 SandboxProvider (`selectProvider`)
// and the Phase 1 BYOK resolution for the e2b key. Generated code only
// ever runs INSIDE the sandbox — never on the host. Network OFF, tools
// mocked under `FORGE_MOCK_TOOLS=1` — identical posture to Phase 1.

import type { BuildFile, KeySource, SandboxLogLine, SandboxPhase } from '@/lib/types';
import { recordCost } from '@/lib/engine/governance/ledger';
import { NeedsKeyError, resolveKey } from '@/lib/engine/keys';
import {
  selectProvider,
  type ExecResult,
  type SandboxProvider,
} from '@/lib/engine/sandbox/provider';
import type { GovernanceScope } from '@/lib/engine/llm';
import type { SystemSpec } from '../spec';
import type { OrchestrationPlan } from '../planner/schema';
import { regenerateSystemModule } from '../codegen/generate';
import {
  parseFailingNode,
  planSystemSmokeTest,
} from './smoke';

// --- Tunable limits (mirrored verbatim from the Phase 1 runner) ---------
// Same caps so a system sandbox can't burn more wall-clock than an
// agent one. Self-heal adds at most one extra build+smoke pass, still
// inside the lifetime budget.
const INSTALL_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 90_000;
const SANDBOX_LIFETIME_MS = 6 * 60_000;
const LOG_BYTE_CAP = 64 * 1024;
const LINE_CLAMP = 4 * 1024;

// --- Public API ------------------------------------------------------------

export interface SystemRunnerInput {
  spec: SystemSpec;
  plan: OrchestrationPlan;
  files: BuildFile[];
  // Governance scope for the cost ledger. The route is expected to
  // have already called assertAllowed() before reaching the runner;
  // we record actual compute_ms here after the sandbox is destroyed.
  governance: GovernanceScope;
}

export interface SystemPhaseSummary {
  phase: SandboxPhase;
  status: 'ok' | 'failed' | 'skipped';
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  // Tag for self-heal so the UI can show which pass each phase came
  // from. Initial pass is iteration 0; the (at most one) self-heal
  // re-runs phases at iteration 1.
  iteration: number;
}

export interface SystemSelfHealAttempt {
  // Which node the orchestrator pointed at when smoke failed.
  node_id: string;
  // Whether the per-node regen produced a static-check-clean file.
  module_regen_ok: boolean;
  // Whether the post-regen smoke pass succeeded.
  smoke_ok_after_retry: boolean;
}

export interface SystemRunnerResult {
  provider: string;
  build_ok: boolean;
  smoke_ok: boolean;
  passed: boolean;
  phases: SystemPhaseSummary[];
  logs: SandboxLogLine[];
  error: string | null;
  duration_ms: number;
  iterations: number;
  // Captured even when the run passes — empty array means no self-heal
  // was attempted. The UI shows this so the reviewer knows the result
  // is post-retry rather than first-pass.
  selfHealAttempts: SystemSelfHealAttempt[];
  // Files we wrote into the sandbox on this run, INCLUDING any
  // regenerated modules. The caller persists these back to build_files
  // so the stored project matches what the sandbox actually tested.
  files: BuildFile[];
}

export async function runSystemSandbox(
  input: SystemRunnerInput,
): Promise<SystemRunnerResult> {
  const start = Date.now();
  const logs: SandboxLogLine[] = [];
  let logBytes = 0;

  function record(
    phase: SandboxLogLine['phase'],
    stream: SandboxLogLine['stream'],
    message: string,
  ) {
    if (logBytes >= LOG_BYTE_CAP) return;
    const clamped =
      message.length > LINE_CLAMP ? message.slice(0, LINE_CLAMP) + '…' : message;
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
  const phases: SystemPhaseSummary[] = [];
  const selfHealAttempts: SystemSelfHealAttempt[] = [];
  // The set of files actually present in the sandbox at the end of
  // the run (mutated on self-heal so persistence reflects what was
  // tested).
  let liveFiles: BuildFile[] = [...input.files];
  let iterations = 0;

  try {
    // --- BYOK: resolve the user's E2B key first --------------------------
    // Same as Phase 1 — NeedsKeyError bubbles to the route which shows
    // the connect-your-key gate.
    let resolved;
    try {
      resolved = await resolveKey(input.governance.user_id ?? null, 'e2b');
    } catch (err) {
      if (err instanceof NeedsKeyError) throw err;
      throw err;
    }
    keySource = resolved.source;

    provider = selectProvider();
    providerName = provider.name;
    record(
      'system',
      'system',
      'system.sandbox.create via ' + providerName + ' (' + keySource + ')',
    );

    await provider.create({
      lifetimeMs: SANDBOX_LIFETIME_MS,
      metadata: { source: 'aurexis-forge', kind: 'system' },
      auth: { apiKey: resolved.key },
    });

    // --- write files (scaffold + orchestrator + entrypoint + modules) ---
    record('system', 'system', 'sandbox.writeFiles ' + liveFiles.length);
    await provider.writeFiles(
      liveFiles.map((f) => ({ path: f.path, content: f.content })),
    );

    // --- write the system smoke driver alongside the project ---
    const smoke = planSystemSmokeTest({ plan: input.plan });
    await provider.writeFiles([
      { path: 'forge_system_smoke.mjs', content: smoke.driverContent },
    ]);

    // --- install (one-time per sandbox; self-heal reuses the install) ---
    record('system', 'system', 'phase.install');
    const installRes = await provider.exec(
      'npm install --no-audit --no-fund --loglevel=error',
      {
        timeoutMs: INSTALL_TIMEOUT_MS,
        env: minimalEnv(),
      },
    );
    captureExec('install', installRes);
    phases.push(toPhase('install', installRes, 0));
    if (installRes.timedOut || installRes.exitCode !== 0) {
      error = 'install failed: ' + describeFailure(installRes);
      phases.push(skippedPhase('build', 0));
      phases.push(skippedPhase('smoke', 0));
      return result();
    }

    // --- build (tsc --noEmit) + smoke (initial pass, iteration 0) ---
    const initial = await buildAndSmoke({
      provider,
      smokeCommand: smoke.command,
      smokeTimeoutMs: smoke.timeoutMs,
      iteration: 0,
      captureExec,
      record,
    });
    phases.push(initial.buildPhase);
    if (!initial.buildOk) {
      phases.push(skippedPhase('smoke', 0));
      error = initial.error;
      return result();
    }
    phases.push(initial.smokePhase);
    if (initial.smokeOk) {
      buildOk = true;
      smokeOk = true;
      return result();
    }

    // --- Bounded self-heal: ONE attempt at most ---------------------------
    // The Phase 1 self-heal pattern is "regenerate the offending file
    // once, then re-test." For systems the offender is a per-node
    // module, identified by the orchestrator's structured smoke
    // output. Anything that doesn't surface a failing node id (e.g.
    // an orchestrator import error) is unrecoverable here.
    const failingNode = parseFailingNode(initial.smokeStdout + '\n' + initial.smokeStderr);
    if (!failingNode) {
      buildOk = true;
      smokeOk = false;
      error = initial.error ?? 'smoke failed before reaching a per-node handoff';
      return result();
    }

    record(
      'system',
      'system',
      "selfheal.attempt node='" + failingNode + "' (iteration 1)",
    );

    let regen;
    try {
      regen = await regenerateSystemModule({
        spec: input.spec,
        plan: input.plan,
        nodeId: failingNode,
        governance: {
          ...input.governance,
          ref: (input.governance.ref ?? 'system.sandbox') + '.selfheal',
        },
      });
    } catch (regenErr) {
      // LLM error or static-check failure during regen — bail out
      // with the original smoke failure preserved.
      buildOk = true;
      smokeOk = false;
      error =
        'self-heal regen failed for node ' +
        failingNode +
        ': ' +
        (regenErr instanceof Error ? regenErr.message : String(regenErr));
      selfHealAttempts.push({
        node_id: failingNode,
        module_regen_ok: false,
        smoke_ok_after_retry: false,
      });
      return result();
    }

    // Patch liveFiles so persistence reflects the regenerated module.
    const newFile: BuildFile = {
      // build_id is filled in by the caller when persisting; the
      // runner only tracks the path + content shape it needs to
      // write into the sandbox.
      id: '',
      build_id: '',
      path: regen.file.path,
      content: regen.file.content,
      source: 'generated',
      bytes: regen.file.bytes,
      created_at: '',
    };
    liveFiles = liveFiles.filter((f) => f.path !== regen.file.path).concat(newFile);

    await provider.writeFiles([
      { path: regen.file.path, content: regen.file.content },
    ]);

    iterations = 1;

    // Re-run build + smoke with the patched module. This is the
    // SECOND and FINAL pass — no further self-heal.
    const retry = await buildAndSmoke({
      provider,
      smokeCommand: smoke.command,
      smokeTimeoutMs: smoke.timeoutMs,
      iteration: 1,
      captureExec,
      record,
    });
    phases.push(retry.buildPhase);
    if (!retry.buildOk) {
      phases.push(skippedPhase('smoke', 1));
      buildOk = true; // initial build was OK; mark retry build-failure as the failing phase
      smokeOk = false;
      error = retry.error;
      selfHealAttempts.push({
        node_id: failingNode,
        module_regen_ok: regen.staticCheckOk,
        smoke_ok_after_retry: false,
      });
      return result();
    }
    phases.push(retry.smokePhase);
    buildOk = true;
    smokeOk = retry.smokeOk;
    if (!smokeOk) {
      error = retry.error;
    }
    selfHealAttempts.push({
      node_id: failingNode,
      module_regen_ok: regen.staticCheckOk,
      smoke_ok_after_retry: smokeOk,
    });

    return result();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    record('system', 'system', 'runner.error ' + error);
    // Re-throw NeedsKeyError so the route can surface a 412 instead
    // of a generic failed run. The finally clause still runs destroy().
    if (err instanceof NeedsKeyError) {
      throw err;
    }
    return result();
  } finally {
    if (provider) {
      try {
        await provider.destroy();
        record('system', 'system', 'sandbox.destroyed');
      } catch (destroyErr) {
        const msg =
          destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
        record('system', 'system', 'sandbox.destroy.error ' + msg);
      }
    }
  }

  function result(): SystemRunnerResult {
    const duration_ms = Date.now() - start;
    // Bill the sandbox compute regardless of pass/fail — we burned the
    // VM either way. recordCost swallows its own errors so this is
    // safe in the success path.
    void recordCost({
      user_id: input.governance.user_id ?? null,
      project_id: input.governance.project_id ?? null,
      kind: 'sandbox',
      compute_ms: duration_ms,
      key_source: keySource,
      ref: input.governance.ref ?? 'system.sandbox.test',
    });
    return {
      provider: providerName,
      build_ok: buildOk,
      smoke_ok: smokeOk,
      passed: buildOk && smokeOk,
      phases,
      logs,
      error,
      duration_ms,
      iterations,
      selfHealAttempts,
      files: liveFiles,
    };
  }
}

// ---------------------------------------------------------------------------
// Build + smoke pair. Used for the initial pass AND the (at most one)
// self-heal retry. Returns enough info for the caller to decide whether
// to attempt a self-heal.
// ---------------------------------------------------------------------------

interface BuildAndSmokeArgs {
  provider: SandboxProvider;
  smokeCommand: string;
  smokeTimeoutMs: number;
  iteration: number;
  captureExec: (phase: SandboxPhase, result: ExecResult) => void;
  record: (
    phase: SandboxLogLine['phase'],
    stream: SandboxLogLine['stream'],
    message: string,
  ) => void;
}

interface BuildAndSmokeResult {
  buildOk: boolean;
  smokeOk: boolean;
  buildPhase: SystemPhaseSummary;
  smokePhase: SystemPhaseSummary;
  smokeStdout: string;
  smokeStderr: string;
  error: string | null;
}

async function buildAndSmoke(
  args: BuildAndSmokeArgs,
): Promise<BuildAndSmokeResult> {
  args.record('system', 'system', 'phase.build (iteration ' + args.iteration + ')');
  const buildRes = await args.provider.exec('npx tsc --noEmit', {
    timeoutMs: BUILD_TIMEOUT_MS,
    env: minimalEnv(),
  });
  args.captureExec('build', buildRes);
  const buildPhase = toPhase('build', buildRes, args.iteration);
  if (buildRes.timedOut || buildRes.exitCode !== 0) {
    return {
      buildOk: false,
      smokeOk: false,
      buildPhase,
      smokePhase: skippedPhase('smoke', args.iteration),
      smokeStdout: '',
      smokeStderr: '',
      error: 'tsc build failed: ' + describeFailure(buildRes),
    };
  }

  args.record(
    'system',
    'system',
    'phase.smoke (iteration ' + args.iteration + ', FORGE_MOCK_TOOLS=1)',
  );
  const smokeRes = await args.provider.exec(args.smokeCommand, {
    timeoutMs: args.smokeTimeoutMs,
    env: smokeEnv(),
  });
  args.captureExec('smoke', smokeRes);
  const smokePhase = toPhase('smoke', smokeRes, args.iteration);
  const smokeOk = smokeRes.exitCode === 0 && !smokeRes.timedOut;
  return {
    buildOk: true,
    smokeOk,
    buildPhase,
    smokePhase,
    smokeStdout: smokeRes.stdout,
    smokeStderr: smokeRes.stderr,
    error: smokeOk ? null : 'smoke failed: ' + describeFailure(smokeRes),
  };
}

// --- Env hygiene -----------------------------------------------------------
// Identical to Phase 1; no platform secrets leak into the sandbox.

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
    FORGE_MOCK_TOOLS: '1',
    FORGE_NETWORK_DISABLED: '1',
  };
}

// --- Helpers ---------------------------------------------------------------

function toPhase(
  phase: SandboxPhase,
  res: ExecResult,
  iteration: number,
): SystemPhaseSummary {
  return {
    phase,
    status: res.timedOut || res.exitCode !== 0 ? 'failed' : 'ok',
    exit_code: res.exitCode,
    timed_out: res.timedOut,
    duration_ms: res.durationMs,
    iteration,
  };
}

function skippedPhase(
  phase: SandboxPhase,
  iteration: number,
): SystemPhaseSummary {
  return {
    phase,
    status: 'skipped',
    exit_code: null,
    timed_out: false,
    duration_ms: 0,
    iteration,
  };
}

function describeFailure(res: ExecResult): string {
  if (res.timedOut) return 'timed out after ' + res.durationMs + 'ms';
  const tail = (res.stderr || res.stdout).split('\n').slice(-6).join('\n').trim();
  return 'exit ' + res.exitCode + (tail ? ' — ' + tail.slice(-400) : '');
}
