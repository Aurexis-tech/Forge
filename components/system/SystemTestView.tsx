// Read-only render of a Phase 2 system sandbox run. Surfaces the
// iteration-aware phase trail (install → build → smoke, possibly
// repeated once for self-heal), per-handoff status, and any self-heal
// attempts the runner recorded. Mirrors the rhythm of the Phase 1
// TestView but tells the system-specific story: handoffs + bounded
// self-heal + max-steps ceiling.

import { GlassPanel } from '@/components/GlassPanel';
import type { SandboxLogLine } from '@/lib/types';

export interface SystemPhaseSummaryLite {
  phase: 'install' | 'build' | 'smoke';
  status: 'ok' | 'failed' | 'skipped';
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  iteration: number;
}

export interface SystemSelfHealAttemptLite {
  node_id: string;
  module_regen_ok: boolean;
  smoke_ok_after_retry: boolean;
}

interface Props {
  passed: boolean;
  buildOk: boolean | null;
  smokeOk: boolean | null;
  durationMs: number | null;
  provider: string;
  iterations: number;
  phases: SystemPhaseSummaryLite[];
  lines: SandboxLogLine[];
  selfHealAttempts: SystemSelfHealAttemptLite[];
  error: string | null;
}

const PHASE_TONE: Record<SystemPhaseSummaryLite['status'], string> = {
  ok: 'border-emerald-400/40 text-emerald-300',
  failed: 'border-rose-400/40 text-rose-300',
  skipped: 'border-white/15 text-forge-dim',
};

export function SystemTestView({
  passed,
  buildOk,
  smokeOk,
  durationMs,
  provider,
  iterations,
  phases,
  lines,
  selfHealAttempts,
  error,
}: Props) {
  const linesByPhase = new Map<string, SandboxLogLine[]>();
  for (const ln of lines) {
    const key = String(ln.phase);
    if (!linesByPhase.has(key)) linesByPhase.set(key, []);
    linesByPhase.get(key)!.push(ln);
  }

  return (
    <GlassPanel className={passed ? 'border-emerald-400/30' : 'border-rose-400/30'}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={
                'inline-block h-2 w-2 rounded-full shadow ' +
                (passed
                  ? 'bg-emerald-300 shadow-emerald-300/40'
                  : 'bg-rose-300 shadow-rose-300/40')
              }
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-text/90">
              system sandbox · {passed ? 'passed' : 'failed'}
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            provider · {provider} ·{' '}
            {typeof durationMs === 'number'
              ? (durationMs / 1000).toFixed(1) + 's'
              : '—'}
            {iterations > 0 ? ' · ' + iterations + ' self-heal' : ''}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-forge-text/90 sm:grid-cols-4">
          <Stat label="build" value={renderTri(buildOk)} />
          <Stat label="smoke" value={renderTri(smokeOk)} />
          <Stat label="iterations" value={iterations} />
          <Stat label="phases" value={phases.length} />
        </div>

        <section>
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
            phase trail
          </h3>
          <ol className="mt-2 flex flex-col gap-1.5">
            {phases.map((p, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2"
              >
                <span
                  className={
                    'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.3em] ' +
                    PHASE_TONE[p.status]
                  }
                >
                  {p.phase} @ {p.iteration} · {p.status}
                </span>
                {p.timed_out ? (
                  <span className="font-mono text-[10px] text-rose-300">
                    timed-out
                  </span>
                ) : null}
                {p.exit_code !== null ? (
                  <span className="font-mono text-[10px] text-forge-dim">
                    exit {p.exit_code}
                  </span>
                ) : null}
                <span className="font-mono text-[10px] text-forge-dim">
                  {(p.duration_ms / 1000).toFixed(1)}s
                </span>
              </li>
            ))}
          </ol>
        </section>

        {selfHealAttempts.length > 0 ? (
          <section>
            <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
              self-heal attempts ({selfHealAttempts.length})
            </h3>
            <ul className="mt-2 flex flex-col gap-2">
              {selfHealAttempts.map((a, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2 font-mono text-[11px] text-amber-100"
                >
                  <p>
                    <span className="text-forge-dim">node: </span>
                    {a.node_id}
                  </p>
                  <p className="mt-1 text-[10px]">
                    <span className="text-forge-dim">regen: </span>
                    {a.module_regen_ok ? 'ok' : 'failed'}
                    <span className="mx-2 text-forge-dim">·</span>
                    <span className="text-forge-dim">smoke after retry: </span>
                    {a.smoke_ok_after_retry ? 'passed' : 'failed'}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 font-mono text-[11px] text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <section>
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
            sandbox logs (last lines)
          </h3>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[10px] leading-5 text-forge-text/85">
            {lines.length === 0
              ? '(no logs captured)'
              : lines
                  .map(
                    (ln) =>
                      '[' +
                      String(ln.phase) +
                      '/' +
                      ln.stream +
                      '] ' +
                      ln.message,
                  )
                  .join('\n')}
          </pre>
        </section>

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {passed
            ? 'locked · system deploy lands next · sandbox always destroyed'
            : 'system sandbox failed · review logs and refine the plan, or regenerate code'}
        </p>
      </div>
    </GlassPanel>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
      <p className="text-forge-dim">{label}</p>
      <p className="mt-1 text-base text-forge-amber">{value}</p>
    </div>
  );
}

function renderTri(v: boolean | null): string {
  if (v === true) return 'ok';
  if (v === false) return 'failed';
  return '—';
}
