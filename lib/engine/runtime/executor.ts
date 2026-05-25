// Runtime executor — one isolated, capped agent execution per call.
//
// Reuses the sandbox provider in LIVE mode:
//   - Tools NOT in mock mode (real network, real API calls)
//   - Real (decrypted) env vars injected only into the isolated sandbox
//   - Sandbox ALWAYS destroyed in a finally block — including on timeout
//   - Hard wall-clock + provider-enforced memory caps
//
// Secrets only ever live in memory inside this module + the sandbox they
// were injected into. They are NEVER logged, NEVER returned, NEVER stored
// in any other table.

import type { BuildPlan } from '../planner/schema';
import { NeedsKeyError, resolveKey } from '../keys';
import { selectProvider, type SandboxProvider } from '../sandbox/provider';
import { planSmokeTest } from '../sandbox/smoke';
import type { AgentSpec } from '../spec/schema';
import type { AgentRunLogLine, BuildFile, KeySource } from '@/lib/types';

const INSTALL_TIMEOUT_MS = 120_000;
const SANDBOX_LIFETIME_MS = 5 * 60_000;
const LOG_BYTE_CAP = 32 * 1024;
const LINE_CLAMP = 2 * 1024;

export interface ExecutorInput {
  spec: AgentSpec;
  plan: BuildPlan;
  files: BuildFile[];
  // Decrypted env values to inject into the sandbox. Caller is responsible
  // for decryption; we don't touch crypto here.
  env: Record<string, string>;
  // Hard wall-clock cap for the run command (the install step has its own
  // separate timeout).
  maxRunMs: number;
  // BYOK: which user is paying for the E2B sandbox. The scheduler passes
  // the runtime's project owner; manual run-now passes the requesting
  // user. Null means platform-key (only valid when REQUIRE_BYOK=false).
  user_id?: string | null;
}

export interface ExecutorResult {
  success: boolean;
  output: unknown | null;
  logs: AgentRunLogLine[];
  error: string | null;
  duration_ms: number;
  provider: string;
  // Whose fuel paid for this run, captured for the cost ledger.
  key_source: KeySource;
}

export async function executeAgentRun(
  input: ExecutorInput,
): Promise<ExecutorResult> {
  const started = Date.now();
  const logs: AgentRunLogLine[] = [];
  let logBytes = 0;

  function record(stream: string, message: string) {
    if (logBytes >= LOG_BYTE_CAP) return;
    const clamped =
      message.length > LINE_CLAMP ? message.slice(0, LINE_CLAMP) + '…' : message;
    const remaining = LOG_BYTE_CAP - logBytes;
    const piece = clamped.length > remaining ? clamped.slice(0, remaining) : clamped;
    logBytes += piece.length;
    logs.push({ stream, message: piece, at: new Date().toISOString() });
  }

  function captureExec(phase: string, res: { stdout: string; stderr: string }) {
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
  let output: unknown = null;
  let error: string | null = null;
  let keySource: KeySource = 'platform';

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
    record('system', 'sandbox.create via ' + providerName + ' (' + keySource + ')');
    await provider.create({
      lifetimeMs: SANDBOX_LIFETIME_MS,
      metadata: { source: 'aurexis-forge-runtime' },
      auth: { apiKey: resolved.key },
    });

    await provider.writeFiles(
      input.files.map((f) => ({ path: f.path, content: f.content })),
    );

    // Reuse the smoke driver. It tries the entrypoint, then src/agent.{ts,js},
    // finds an AgentDefinition export, and invokes runOnce. In LIVE mode the
    // tool library uses real implementations.
    const driver = planSmokeTest({ spec: input.spec, plan: input.plan });
    await provider.writeFiles([
      { path: 'forge_smoke.mjs', content: driver.driverContent },
    ]);

    // --- install (network on; this is expected) ---
    record('system', 'phase.install');
    const installRes = await provider.exec(
      'npm install --no-audit --no-fund --loglevel=error',
      { timeoutMs: INSTALL_TIMEOUT_MS, env: minimalEnv() },
    );
    captureExec('install', installRes);
    if (installRes.timedOut || installRes.exitCode !== 0) {
      throw new Error('install failed: exit ' + installRes.exitCode);
    }

    // --- live run ---
    record(
      'system',
      'phase.run (LIVE, ' + Object.keys(input.env).length + ' env keys)',
    );
    const runRes = await provider.exec(driver.command, {
      timeoutMs: input.maxRunMs,
      stdin: driver.stdin,
      env: liveEnv(input.env),
    });
    captureExec('run', runRes);

    if (runRes.exitCode === 0 && !runRes.timedOut) {
      success = true;
      output = extractAgentOutput(runRes.stdout);
    } else if (driver.softTimeout && runRes.timedOut) {
      // Server-style entrypoints (api/webhook) don't exit on their own. We
      // accept a timeout with clean stderr as a healthy run.
      const noStderrError = !/error|exception|trace|cannot find module|enoent/i.test(
        runRes.stderr || '',
      );
      if (noStderrError) {
        success = true;
        output = { soft_timeout: true };
      } else {
        error = 'run failed (timeout with stderr): ' + summariseStderr(runRes.stderr);
      }
    } else {
      error =
        'run failed: exit ' +
        runRes.exitCode +
        (runRes.timedOut ? ' (timed out after ' + input.maxRunMs + 'ms)' : '') +
        (runRes.stderr ? ' — ' + summariseStderr(runRes.stderr) : '');
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    record('system', 'executor.error ' + error);
  } finally {
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
    logs,
    error,
    duration_ms: Date.now() - started,
    provider: providerName,
    key_source: keySource,
  };
}

// --- Helpers ---------------------------------------------------------------

function minimalEnv(): Record<string, string> {
  return { NODE_ENV: 'production', CI: '1' };
}

// LIVE env merges the user's declared env on top of a minimal base. We
// deliberately do NOT set FORGE_MOCK_TOOLS — runtime is real execution.
function liveEnv(real: Record<string, string>): Record<string, string> {
  return {
    NODE_ENV: 'production',
    CI: '0',
    ...real,
  };
}

function extractAgentOutput(stdout: string): unknown {
  // The smoke driver logs `[smoke] agent_invoked { "result_preview": "..." }`
  // on successful invocation. Pull the most recent one and parse it.
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    const idx = line.indexOf('agent_invoked');
    if (idx < 0) continue;
    const jsonStart = line.indexOf('{', idx);
    if (jsonStart < 0) continue;
    try {
      return JSON.parse(line.slice(jsonStart));
    } catch {
      // fall through and keep looking
    }
  }
  return null;
}

function summariseStderr(stderr: string): string {
  const lines = (stderr || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.slice(-3).join(' | ').slice(-400);
}
