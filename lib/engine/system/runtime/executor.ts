// Aurexis Forge — Phase 2 (Systems) runtime executor.
//
// Runs ONE orchestration end-to-end inside a live, isolated sandbox.
// REUSES the Phase 1 sandbox provider abstraction (`selectProvider`,
// `resolveKey('e2b')`) and mirrors the Phase 1 executor's posture:
// sandbox always destroyed in finally, install timeout, log capture,
// LIVE env hygiene (no FORGE_MOCK_TOOLS — real tools).
//
// The deployable IS the orchestrator (P2-5a), so running it runs the
// whole coordinated system. The orchestrator's two non-negotiables
// (MAX-STEPS ceiling + per-handoff validation, both baked in at
// P2-3) surface here as clean run failures — never a runaway.
//
// SHARED COST CEILING (Phase 2 non-negotiable):
//   - Pre-run: the scheduler's `runOnce` already calls assertAllowed
//     with projectedCostUsd(maxRunMs) BEFORE this executor is invoked.
//     One run = ONE governed unit spanning N agents.
//   - DURING run: a parallel kill-switch watcher polls every 4 seconds.
//     If a global / user / project kill switch fires mid-flight, the
//     watcher calls provider.destroy() which forcibly tears down the
//     sandbox — the in-flight exec returns failed with a clear marker.
//   - Post-run: the scheduler records the run's total compute_ms in
//     the ledger as ONE event (kind='runtime'), not N per-agent events.
//
// Secrets only ever live in memory in this module + the sandbox they
// were injected into. They are NEVER logged, NEVER returned, NEVER
// stored in any other table.

import type { AgentRunLogLine, BuildFile, KeySource } from '@/lib/types';
import type { ForgeSupabase } from '@/lib/supabase';
import { NeedsKeyError, resolveKey } from '@/lib/engine/keys';
import {
  selectProvider,
  type SandboxProvider,
} from '@/lib/engine/sandbox/provider';
import { activeKillSwitch } from '@/lib/engine/governance/killswitch';
import type { OrchestrationPlan } from '../planner/schema';
import type { SystemSpec } from '../spec';
import {
  parseLiveRunFailure,
  parseLiveRunResult,
  planSystemLiveRun,
} from './driver';

// Same limits as the Phase 1 runtime executor.
const INSTALL_TIMEOUT_MS = 120_000;
const SANDBOX_LIFETIME_MS = 5 * 60_000;
const LOG_BYTE_CAP = 32 * 1024;
const LINE_CLAMP = 2 * 1024;
// Kill-switch watcher cadence. Short enough to halt a run within a
// few seconds; long enough that a tick burns negligible DB time.
const KILL_WATCH_INTERVAL_MS = 4_000;

export interface SystemExecutorInput {
  spec: SystemSpec;
  plan: OrchestrationPlan;
  files: BuildFile[];
  // Decrypted env values to inject. Caller is responsible for
  // decryption; we don't touch crypto here.
  env: Record<string, string>;
  maxRunMs: number;
  // Whose fuel pays for the sandbox + LLM calls inside. The scheduler
  // passes the runtime's project owner.
  user_id?: string | null;
  project_id?: string | null;
  // Optional injected supabase client for the kill-switch watcher. The
  // tests stub this so the watcher polls the in-memory db.
  supabase?: ForgeSupabase;
}

export interface SystemExecutorResult {
  success: boolean;
  output: {
    steps: number;
    final_node: string;
    output_keys: string[];
  } | null;
  // Per-handoff trail captured from the driver. Empty array on a
  // clean pass — populated with one entry per failed handoff.
  handoff_failure: { node: string | null; message: string } | null;
  logs: AgentRunLogLine[];
  error: string | null;
  duration_ms: number;
  provider: string;
  key_source: KeySource;
  // True when the kill switch fired mid-run and the watcher tore down
  // the sandbox. Surfaces as a distinct run-failure cause.
  killed_by_kill_switch: boolean;
  // Tally of agent invocations the orchestrator actually walked. On
  // success this equals plan.nodes.length; on failure it's the
  // step the orchestrator was at when it threw.
  steps_completed: number;
}

export async function executeSystemRun(
  input: SystemExecutorInput,
): Promise<SystemExecutorResult> {
  const started = Date.now();
  const logs: AgentRunLogLine[] = [];
  let logBytes = 0;

  function record(stream: string, message: string) {
    if (logBytes >= LOG_BYTE_CAP) return;
    const clamped =
      message.length > LINE_CLAMP ? message.slice(0, LINE_CLAMP) + '…' : message;
    const remaining = LOG_BYTE_CAP - logBytes;
    const piece =
      clamped.length > remaining ? clamped.slice(0, remaining) : clamped;
    logBytes += piece.length;
    logs.push({ stream, message: piece, at: new Date().toISOString() });
  }

  function captureExec(
    phase: string,
    res: { stdout: string; stderr: string },
  ) {
    for (const line of (res.stdout || '').split('\n')) {
      if (line) record(phase + '/stdout', line);
    }
    for (const line of (res.stderr || '').split('\n')) {
      if (line) record(phase + '/stderr', line);
    }
  }

  let provider: SandboxProvider | null = null;
  let providerName = process.env.SANDBOX_PROVIDER ?? 'e2b';
  let success = false;
  let output: SystemExecutorResult['output'] = null;
  let handoffFailure: SystemExecutorResult['handoff_failure'] = null;
  let error: string | null = null;
  let keySource: KeySource = 'platform';
  let killedByKillSwitch = false;
  let stepsCompleted = 0;
  let killWatcher: ReturnType<typeof setInterval> | null = null;

  try {
    // --- BYOK: resolve the E2B key for the runtime's owner ---------------
    let resolved;
    try {
      resolved = await resolveKey(input.user_id ?? null, 'e2b');
    } catch (err) {
      if (err instanceof NeedsKeyError) throw err;
      throw err;
    }
    keySource = resolved.source;

    provider = selectProvider();
    providerName = provider.name;
    record(
      'system',
      'system.sandbox.create via ' + providerName + ' (' + keySource + ')',
    );

    await provider.create({
      lifetimeMs: SANDBOX_LIFETIME_MS,
      metadata: { source: 'aurexis-forge-runtime', kind: 'system' },
      auth: { apiKey: resolved.key },
    });

    // --- Arm the mid-flight kill-switch watcher --------------------------
    // The watcher polls the kill_switches table every few seconds. If an
    // active kill switch covers (global / user / project) the running
    // system, we call provider.destroy() — the in-flight exec returns
    // timed-out / failed and the run gets recorded as killed-mid-run.
    if (input.supabase) {
      const watcherSupabase = input.supabase;
      killWatcher = setInterval(() => {
        void (async () => {
          if (killedByKillSwitch) return;
          try {
            const kill = await activeKillSwitch(
              {
                userId: input.user_id ?? null,
                projectId: input.project_id ?? null,
              },
              watcherSupabase,
            );
            if (kill && !killedByKillSwitch) {
              killedByKillSwitch = true;
              record(
                'system',
                'kill_switch.fired scope=' +
                  kill.scope +
                  ' — tearing down sandbox',
              );
              try {
                if (provider) await provider.destroy();
              } catch {
                /* swallow — finally will retry */
              }
            }
          } catch {
            // Polling errors are non-fatal; the next tick will try
            // again. Don't log to avoid log spam.
          }
        })();
      }, KILL_WATCH_INTERVAL_MS);
    }

    // --- Write project files + the live driver ---------------------------
    await provider.writeFiles(
      input.files.map((f) => ({ path: f.path, content: f.content })),
    );

    const driver = planSystemLiveRun({
      plan: input.plan,
      maxRunMs: input.maxRunMs,
    });
    await provider.writeFiles([
      { path: 'forge_system_live.mjs', content: driver.driverContent },
    ]);

    // --- install (network on; this is expected) --------------------------
    record('system', 'phase.install');
    const installRes = await provider.exec(
      'npm install --no-audit --no-fund --loglevel=error',
      { timeoutMs: INSTALL_TIMEOUT_MS, env: minimalEnv() },
    );
    captureExec('install', installRes);
    if (installRes.timedOut || installRes.exitCode !== 0) {
      throw new Error('install failed: exit ' + installRes.exitCode);
    }

    // --- live orchestration run ------------------------------------------
    record(
      'system',
      'phase.run (LIVE, ' +
        Object.keys(input.env).length +
        ' env keys, max_run_ms=' +
        String(input.maxRunMs) +
        ')',
    );
    const runRes = await provider.exec(driver.command, {
      timeoutMs: driver.timeoutMs,
      env: liveEnv(input.env),
    });
    captureExec('run', runRes);

    if (killedByKillSwitch) {
      // The watcher tore the sandbox down. The exec returned with
      // whatever the provider produces post-destroy; we treat it
      // unconditionally as a kill-switch failure.
      error =
        'run halted mid-flight: kill switch active for this run\'s scope';
    } else if (runRes.exitCode === 0 && !runRes.timedOut) {
      const passed = parseLiveRunResult(runRes.stdout + '\n' + runRes.stderr);
      if (passed) {
        success = true;
        output = passed;
        stepsCompleted = passed.steps;
      } else {
        error =
          'run finished with exit 0 but no orchestrate_passed marker was emitted';
      }
    } else {
      // Failed exit or timeout. Try to surface the orchestrator's
      // structured failure (failing node + message) so the run record
      // pinpoints the breakage.
      const failure = parseLiveRunFailure(
        runRes.stdout + '\n' + runRes.stderr,
      );
      if (failure) {
        handoffFailure = failure;
        error =
          'orchestrator failed at node ' +
          String(failure.node) +
          ': ' +
          failure.message;
      } else if (runRes.timedOut) {
        error = 'run timed out after ' + String(input.maxRunMs) + 'ms';
      } else {
        error =
          'run failed: exit ' +
          String(runRes.exitCode) +
          (runRes.stderr ? ' — ' + summariseStderr(runRes.stderr) : '');
      }
    }
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Surface to the scheduler — same shape as the Phase 1 executor;
      // the scheduler maps this to a friendly 412 in the route layer.
      if (killWatcher) clearInterval(killWatcher);
      throw err;
    }
    error = err instanceof Error ? err.message : String(err);
    record('system', 'executor.error ' + error);
  } finally {
    if (killWatcher) clearInterval(killWatcher);
    if (provider) {
      try {
        await provider.destroy();
        record('system', 'sandbox.destroyed');
      } catch (destroyErr) {
        const msg =
          destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
        record('system', 'sandbox.destroy.error ' + msg);
      }
    }
  }

  return {
    success,
    output,
    handoff_failure: handoffFailure,
    logs,
    error,
    duration_ms: Date.now() - started,
    provider: providerName,
    key_source: keySource,
    killed_by_kill_switch: killedByKillSwitch,
    steps_completed: stepsCompleted,
  };
}

// --- Env hygiene -----------------------------------------------------------

function minimalEnv(): Record<string, string> {
  return { NODE_ENV: 'production', CI: '1' };
}

// LIVE env merges the user's declared env on top of a minimal base.
// Critically: we deliberately do NOT set FORGE_MOCK_TOOLS — runtime is
// real execution.
function liveEnv(real: Record<string, string>): Record<string, string> {
  return {
    NODE_ENV: 'production',
    CI: '0',
    ...real,
  };
}

function summariseStderr(stderr: string): string {
  const lines = (stderr || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.slice(-3).join(' | ').slice(-400);
}
