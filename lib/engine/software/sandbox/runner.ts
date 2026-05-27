// Aurexis Forge — Phase 3 (Software) sandbox runner.
//
// Strict-ordered:
//   create() → writeFiles() → install → build (next build) →
//     pre-isolation install (pglite) → isolation driver
//   [if build failed AND a single LLM-filled slot looks responsible]
//     → regenerate that slot via the P3-3 generator → re-write file
//     → re-build → re-isolation (single bounded retry)
//   → destroy()
//
// destroy() ALWAYS runs in finally — same security perimeter as
// Phases 1 + 2. Generated code only ever runs INSIDE the sandbox;
// network OFF outside install/build (the isolation driver uses
// pglite, an in-process Postgres with no network).
//
// THE ISOLATION TEST IS BUILD-FAILING AND DOES NOT SELF-HEAL.
// A structural RLS leak means the migration emit OR the LLM slots
// inserted code that bypasses RLS — neither is something a single
// "regenerate the failing slot" can reliably fix, and silently
// retrying would hide the actual breakage. Self-heal fires ONLY
// on a build (`next build`) failure, never on an isolation leak.

import type { BuildFile, KeySource, SandboxLogLine, SandboxPhase } from '@/lib/types';
import type { ForgeSupabase } from '@/lib/supabase';
import { recordCost } from '@/lib/engine/governance/ledger';
import { NeedsKeyError, resolveKey } from '@/lib/engine/keys';
import {
  selectProvider,
  type ExecResult,
  type SandboxProvider,
} from '@/lib/engine/sandbox/provider';
import type { GovernanceScope } from '@/lib/engine/llm';
import type { SoftwareSpec } from '../spec';
import type { SoftwareBuildPlan } from '../planner/schema';
import { regenerateSoftwareSlot } from '../codegen/generate';
import {
  parseIsolationResult,
  planIsolationTest,
  type IsolationResult,
} from './isolation';

// --- Tunable limits (mirrored from Phases 1/2; isolation has its own cap) -
const INSTALL_TIMEOUT_MS = 180_000;     // next + supabase deps are heavier
const BUILD_TIMEOUT_MS = 180_000;        // next build is the heavy phase
const PGLITE_INSTALL_TIMEOUT_MS = 60_000;
const SANDBOX_LIFETIME_MS = 8 * 60_000;
const LOG_BYTE_CAP = 64 * 1024;
const LINE_CLAMP = 4 * 1024;

// --- Public API ------------------------------------------------------------

export interface SoftwareRunnerInput {
  spec: SoftwareSpec;
  plan: SoftwareBuildPlan;
  files: BuildFile[];
  governance: GovernanceScope;
}

export interface SoftwarePhaseSummary {
  phase: SandboxPhase | 'isolation';
  status: 'ok' | 'failed' | 'skipped';
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  iteration: number;
}

export interface SoftwareSelfHealAttempt {
  // Path of the slot the runner regenerated.
  file_path: string;
  // Was the regen LLM call static-check-clean?
  slot_regen_ok: boolean;
  // Was the post-regen build (and subsequent isolation) successful?
  build_ok_after_retry: boolean;
  isolation_ok_after_retry: boolean;
}

export interface SoftwareRunnerResult {
  provider: string;
  build_ok: boolean;
  // Result of the cross-user isolation test. Even when the build
  // passes, isolation can still fail — in that case isolation_ok
  // is false and `passed` is false.
  isolation_ok: boolean;
  // Structured isolation outcome (parsed from the driver's
  // [isolation] terminal line). Null when the build failed before
  // isolation could run.
  isolation: IsolationResult | null;
  passed: boolean;
  phases: SoftwarePhaseSummary[];
  logs: SandboxLogLine[];
  error: string | null;
  duration_ms: number;
  iterations: number;
  selfHealAttempts: SoftwareSelfHealAttempt[];
  // Files we wrote into the sandbox on this run, INCLUDING any
  // regenerated slot file. The caller persists patches back to
  // build_files so the stored project matches what the sandbox
  // actually tested.
  files: BuildFile[];
}

export async function runSoftwareSandbox(
  input: SoftwareRunnerInput,
): Promise<SoftwareRunnerResult> {
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
    const piece =
      clamped.length > remaining ? clamped.slice(0, remaining) : clamped;
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
  let isolationOk = false;
  let isolation: IsolationResult | null = null;
  let error: string | null = null;
  let keySource: KeySource = 'platform';
  const phases: SoftwarePhaseSummary[] = [];
  const selfHealAttempts: SoftwareSelfHealAttempt[] = [];
  let liveFiles: BuildFile[] = [...input.files];
  let iterations = 0;

  try {
    // --- BYOK: resolve the E2B key ---------------------------------------
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
      'software.sandbox.create via ' + providerName + ' (' + keySource + ')',
    );

    await provider.create({
      lifetimeMs: SANDBOX_LIFETIME_MS,
      metadata: { source: 'aurexis-forge', kind: 'software' },
      auth: { apiKey: resolved.key },
    });

    // --- write files (scaffold + migration + LLM slots + shells) ----
    record('system', 'system', 'sandbox.writeFiles ' + liveFiles.length);
    await provider.writeFiles(
      liveFiles.map((f) => ({ path: f.path, content: f.content })),
    );

    // --- write the isolation driver ---
    const iso = planIsolationTest({ spec: input.spec });
    await provider.writeFiles([
      { path: 'forge_isolation.mjs', content: iso.driverContent },
    ]);

    // --- install (the generated app's deps) ---
    record('system', 'system', 'phase.install');
    const installRes = await provider.exec(
      'npm install --no-audit --no-fund --loglevel=error',
      { timeoutMs: INSTALL_TIMEOUT_MS, env: minimalEnv() },
    );
    captureExec('install', installRes);
    phases.push(toPhase('install', installRes, 0));
    if (installRes.timedOut || installRes.exitCode !== 0) {
      error = 'install failed: ' + describeFailure(installRes);
      phases.push(skippedPhase('build', 0));
      phases.push(skippedPhase('isolation', 0));
      return result();
    }

    // --- initial build + isolation (iteration 0) ---
    const initial = await buildAndIsolate({
      provider,
      iso,
      iteration: 0,
      captureExec,
      record,
    });
    phases.push(initial.buildPhase);
    if (!initial.buildOk) {
      // Self-heal only fires on build failure. We try to locate the
      // offending slot file from the build stderr; if we can, we
      // regenerate it and re-run build + isolation ONCE.
      phases.push(skippedPhase('isolation', 0));
      const offending = identifyOffendingSlotFile(
        initial.buildStderr + '\n' + initial.buildStdout,
      );
      if (!offending) {
        error =
          'build failed and no LLM-filled slot file was identifiable for self-heal: ' +
          initial.error;
        return result();
      }
      const healed = await attemptSelfHeal({
        provider,
        record,
        iso,
        captureExec,
        offendingPath: offending,
        input,
        liveFiles,
      });
      iterations = 1;
      selfHealAttempts.push(healed.attempt);
      liveFiles = healed.liveFiles;
      phases.push(healed.buildPhase);
      if (!healed.buildOk) {
        phases.push(skippedPhase('isolation', 1));
        error = healed.error;
        return result();
      }
      phases.push(healed.isolationPhase!);
      buildOk = true;
      isolation = healed.isolation;
      isolationOk = healed.isolationOk;
      if (!isolationOk) {
        // Isolation failed AFTER self-heal — still a hard stop. We
        // don't retry isolation; surface loudly.
        error =
          'isolation failed after self-heal: ' +
          (healed.isolation?.errorMessage ?? 'B saw A rows');
      }
      return result();
    }
    phases.push(initial.isolationPhase!);
    buildOk = true;
    isolation = initial.isolation;
    isolationOk = initial.isolationOk;
    if (!isolationOk) {
      // HARD STOP — isolation leaks do not self-heal. Surface the
      // structured leak details so the audit log can show which
      // table leaked + how many rows.
      error =
        'cross-user isolation FAILED: ' +
        (initial.isolation?.errorMessage ?? 'B saw A rows');
    }

    return result();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    record('system', 'system', 'runner.error ' + error);
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
          destroyErr instanceof Error
            ? destroyErr.message
            : String(destroyErr);
        record('system', 'system', 'sandbox.destroy.error ' + msg);
      }
    }
  }

  function result(): SoftwareRunnerResult {
    const duration_ms = Date.now() - start;
    void recordCost({
      user_id: input.governance.user_id ?? null,
      project_id: input.governance.project_id ?? null,
      kind: 'sandbox',
      compute_ms: duration_ms,
      key_source: keySource,
      ref: input.governance.ref ?? 'software.sandbox.test',
    });
    return {
      provider: providerName,
      build_ok: buildOk,
      isolation_ok: isolationOk,
      isolation,
      passed: buildOk && isolationOk,
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
// Build + isolation pair. The isolation install runs INSIDE this
// helper after a successful build — so a build failure short-circuits
// before we pay the pglite install cost.
// ---------------------------------------------------------------------------

interface BuildAndIsolateArgs {
  provider: SandboxProvider;
  iso: ReturnType<typeof planIsolationTest>;
  iteration: number;
  captureExec: (phase: SandboxPhase, result: ExecResult) => void;
  record: (
    phase: SandboxLogLine['phase'],
    stream: SandboxLogLine['stream'],
    message: string,
  ) => void;
}

interface BuildAndIsolateResult {
  buildOk: boolean;
  isolationOk: boolean;
  isolation: IsolationResult | null;
  buildPhase: SoftwarePhaseSummary;
  isolationPhase: SoftwarePhaseSummary | null;
  buildStdout: string;
  buildStderr: string;
  error: string | null;
}

async function buildAndIsolate(
  args: BuildAndIsolateArgs,
): Promise<BuildAndIsolateResult> {
  // --- next build ---
  args.record(
    'system',
    'system',
    'phase.build (iteration ' + args.iteration + ')',
  );
  const buildRes = await args.provider.exec(
    'npx next build',
    { timeoutMs: BUILD_TIMEOUT_MS, env: nextBuildEnv() },
  );
  args.captureExec('build', buildRes);
  const buildPhase = toPhase('build', buildRes, args.iteration);
  if (buildRes.timedOut || buildRes.exitCode !== 0) {
    return {
      buildOk: false,
      isolationOk: false,
      isolation: null,
      buildPhase,
      isolationPhase: null,
      buildStdout: buildRes.stdout,
      buildStderr: buildRes.stderr,
      error: 'next build failed: ' + describeFailure(buildRes),
    };
  }

  // --- install pglite (throwaway dep for the isolation phase only) ---
  args.record(
    'system',
    'system',
    'phase.isolation.install_pglite (iteration ' + args.iteration + ')',
  );
  const pgRes = await args.provider.exec(args.iso.preInstallCommand, {
    timeoutMs: PGLITE_INSTALL_TIMEOUT_MS,
    env: minimalEnv(),
  });
  args.captureExec('install', pgRes);
  if (pgRes.timedOut || pgRes.exitCode !== 0) {
    return {
      buildOk: true,
      isolationOk: false,
      isolation: {
        outcome: 'errored',
        perEntity: {},
        leakTable: null,
        leakCount: 0,
        errorMessage: 'pglite install failed: ' + describeFailure(pgRes),
        vacuous: false,
      },
      buildPhase,
      isolationPhase: errorPhase('isolation', args.iteration),
      buildStdout: buildRes.stdout,
      buildStderr: buildRes.stderr,
      error: 'pglite install failed: ' + describeFailure(pgRes),
    };
  }

  // --- isolation driver ---
  args.record(
    'system',
    'system',
    'phase.isolation (iteration ' + args.iteration + ')',
  );
  const isoRes = await args.provider.exec(args.iso.command, {
    timeoutMs: args.iso.timeoutMs,
    env: isolationEnv(),
  });
  args.captureExec('smoke', isoRes); // capture under 'smoke' phase (SandboxPhase enum)
  const isolation = parseIsolationResult(isoRes.stdout + '\n' + isoRes.stderr);
  const isolationOk = isolation.outcome === 'passed';
  const isolationPhase: SoftwarePhaseSummary = {
    phase: 'isolation',
    status: isolationOk
      ? 'ok'
      : isolation.outcome === 'errored'
        ? 'failed'
        : 'failed',
    exit_code: isoRes.exitCode,
    timed_out: isoRes.timedOut,
    duration_ms: isoRes.durationMs,
    iteration: args.iteration,
  };

  return {
    buildOk: true,
    isolationOk,
    isolation,
    buildPhase,
    isolationPhase,
    buildStdout: buildRes.stdout,
    buildStderr: buildRes.stderr,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Bounded self-heal. Regenerates ONE slot file via the P3-3
// generator, writes it into the live sandbox, then re-runs the full
// build + isolation pair ONCE. Hard-capped at this single attempt.
// ---------------------------------------------------------------------------

interface AttemptSelfHealArgs {
  provider: SandboxProvider;
  iso: ReturnType<typeof planIsolationTest>;
  offendingPath: string;
  input: SoftwareRunnerInput;
  liveFiles: BuildFile[];
  captureExec: (phase: SandboxPhase, result: ExecResult) => void;
  record: (
    phase: SandboxLogLine['phase'],
    stream: SandboxLogLine['stream'],
    message: string,
  ) => void;
}

interface AttemptSelfHealResult {
  attempt: SoftwareSelfHealAttempt;
  liveFiles: BuildFile[];
  buildOk: boolean;
  isolationOk: boolean;
  isolation: IsolationResult | null;
  buildPhase: SoftwarePhaseSummary;
  isolationPhase: SoftwarePhaseSummary | null;
  error: string | null;
}

async function attemptSelfHeal(
  args: AttemptSelfHealArgs,
): Promise<AttemptSelfHealResult> {
  args.record(
    'system',
    'system',
    "selfheal.attempt file='" + args.offendingPath + "' (iteration 1)",
  );

  let regen;
  try {
    regen = await regenerateSoftwareSlot({
      spec: args.input.spec,
      plan: args.input.plan,
      filePath: args.offendingPath,
      governance: {
        ...args.input.governance,
        ref:
          (args.input.governance.ref ?? 'software.sandbox') + '.selfheal',
      },
    });
  } catch (regenErr) {
    return {
      attempt: {
        file_path: args.offendingPath,
        slot_regen_ok: false,
        build_ok_after_retry: false,
        isolation_ok_after_retry: false,
      },
      liveFiles: args.liveFiles,
      buildOk: false,
      isolationOk: false,
      isolation: null,
      buildPhase: errorPhase('build', 1),
      isolationPhase: null,
      error:
        'self-heal regen failed for ' +
        args.offendingPath +
        ': ' +
        (regenErr instanceof Error ? regenErr.message : String(regenErr)),
    };
  }

  // Patch liveFiles so persistence reflects the regenerated slot.
  const newFile: BuildFile = {
    id: '',
    build_id: '',
    path: regen.file.path,
    content: regen.file.content,
    source: 'generated',
    bytes: regen.file.bytes,
    created_at: '',
  };
  const liveFiles = args.liveFiles
    .filter((f) => f.path !== regen.file.path)
    .concat(newFile);

  // Write the patched file into the sandbox + re-run build + isolation.
  await args.provider.writeFiles([
    { path: regen.file.path, content: regen.file.content },
  ]);

  const retry = await buildAndIsolate({
    provider: args.provider,
    iso: args.iso,
    iteration: 1,
    captureExec: args.captureExec,
    record: args.record,
  });

  return {
    attempt: {
      file_path: args.offendingPath,
      slot_regen_ok: regen.file.staticCheck.ok,
      build_ok_after_retry: retry.buildOk,
      isolation_ok_after_retry: retry.isolationOk,
    },
    liveFiles,
    buildOk: retry.buildOk,
    isolationOk: retry.isolationOk,
    isolation: retry.isolation,
    buildPhase: retry.buildPhase,
    isolationPhase: retry.isolationPhase,
    error: retry.error,
  };
}

// ---------------------------------------------------------------------------
// Build-failure analysis. Walks the next build stderr for a TS/Next
// compile error pointing at a file. Returns the path ONLY when it
// matches an LLM-filled slot pattern; otherwise null (which means
// the runner does NOT self-heal — the build failure points at a
// scaffold file, the migration, or somewhere we can't fix
// surgically).
// ---------------------------------------------------------------------------

const SLOT_PATH_RE =
  /\b(app\/api\/[a-z][a-z0-9_]*(?:\/\[id\])?\/_(?:list|create|update|delete)\.ts)\b|\b(app\/\(app\)\/[a-z0-9-]+\/page\.tsx)\b/;

export function identifyOffendingSlotFile(combined: string): string | null {
  const match = combined.match(SLOT_PATH_RE);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

// ---------------------------------------------------------------------------
// Env hygiene — minimal envs that DON'T leak Forge platform secrets
// into the sandbox.
// ---------------------------------------------------------------------------

function minimalEnv(): Record<string, string> {
  return { NODE_ENV: 'production', CI: '1' };
}

// next build needs the public Supabase env vars to be present at
// BUILD time (Next.js inlines NEXT_PUBLIC_* into the browser bundle).
// We pass synthetic placeholders so the build itself can resolve
// process.env reads without us leaking real keys into the sandbox.
function nextBuildEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    CI: '1',
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sandbox-anon-key-not-real',
  };
}

function isolationEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    CI: '1',
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function toPhase(
  phase: SandboxPhase,
  res: ExecResult,
  iteration: number,
): SoftwarePhaseSummary {
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
  phase: SandboxPhase | 'isolation',
  iteration: number,
): SoftwarePhaseSummary {
  return {
    phase,
    status: 'skipped',
    exit_code: null,
    timed_out: false,
    duration_ms: 0,
    iteration,
  };
}

function errorPhase(
  phase: SandboxPhase | 'isolation',
  iteration: number,
): SoftwarePhaseSummary {
  return {
    phase,
    status: 'failed',
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
