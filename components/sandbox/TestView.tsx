// Pure render of a sandbox_run result. Phase pills + read-only console.

import type { SandboxLogLine } from '@/lib/types';

export interface PhaseStatus {
  phase: 'install' | 'build' | 'smoke';
  status: 'ok' | 'failed' | 'skipped' | 'pending';
  exit_code?: number | null;
  timed_out?: boolean;
  duration_ms?: number;
}

interface Props {
  phases: PhaseStatus[];
  lines: SandboxLogLine[];
  buildOk: boolean | null;
  smokeOk: boolean | null;
  durationMs: number | null;
  provider: string;
  error: string | null;
}

const PHASE_LABEL: Record<PhaseStatus['phase'], string> = {
  install: '01 · install',
  build: '02 · build',
  smoke: '03 · smoke',
};

export function TestView({
  phases,
  lines,
  buildOk,
  smokeOk,
  durationMs,
  provider,
  error,
}: Props) {
  const ordered = ensureAllPhases(phases);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ordered.map((p) => (
          <PhaseCard key={p.phase} phase={p} />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          <span>provider · {provider}</span>
          {durationMs != null ? <span>· {formatDuration(durationMs)}</span> : null}
          <span>· build {boolLabel(buildOk)}</span>
          <span>· smoke {boolLabel(smokeOk)}</span>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-400/50 bg-rose-500/[0.07] p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-300">
            sandbox error
          </p>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-sm text-rose-200/90">
            {error}
          </pre>
        </div>
      ) : null}

      <Console lines={lines} />
    </div>
  );
}

function PhaseCard({ phase }: { phase: PhaseStatus }) {
  const tone = STATUS_TONE[phase.status];
  return (
    <div
      className={
        'flex flex-col gap-2 rounded-xl border bg-black/30 p-3 ' + tone.border
      }
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {PHASE_LABEL[phase.phase]}
        </span>
        <span
          className={
            'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] ' +
            tone.pill
          }
        >
          {phase.status}
        </span>
      </div>
      <div className="flex items-center justify-between font-mono text-[10px] text-forge-dim">
        <span>{phase.duration_ms != null ? formatDuration(phase.duration_ms) : '—'}</span>
        <span>
          {phase.timed_out
            ? 'timed out'
            : phase.exit_code != null
              ? 'exit ' + phase.exit_code
              : ''}
        </span>
      </div>
    </div>
  );
}

function Console({ lines }: { lines: SandboxLogLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="text-sm text-forge-dim">No log lines were captured.</p>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/60">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          captured console
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {lines.length} lines
        </p>
      </div>
      <div className="max-h-[40vh] overflow-y-auto p-3">
        <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
          {lines.map((line, i) => (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 text-forge-dim">
                {String(line.phase).padEnd(7, ' ')}
              </span>
              <span className={STREAM_TONE[line.stream]}>{line.message}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

const STATUS_TONE: Record<PhaseStatus['status'], { border: string; pill: string }> = {
  ok: {
    border: 'border-emerald-400/40',
    pill: 'border-emerald-400/40 text-emerald-300',
  },
  failed: {
    border: 'border-rose-400/50',
    pill: 'border-rose-400/50 text-rose-300',
  },
  skipped: {
    border: 'border-white/10',
    pill: 'border-white/15 text-forge-dim',
  },
  pending: {
    border: 'border-white/10',
    pill: 'border-white/15 text-forge-dim',
  },
};

const STREAM_TONE: Record<SandboxLogLine['stream'], string> = {
  stdout: 'text-forge-text/90',
  stderr: 'text-rose-300/90',
  system: 'text-forge-cyan/80',
};

function ensureAllPhases(phases: PhaseStatus[]): PhaseStatus[] {
  const map = new Map(phases.map((p) => [p.phase, p]));
  const order: PhaseStatus['phase'][] = ['install', 'build', 'smoke'];
  return order.map(
    (phase) =>
      map.get(phase) ?? {
        phase,
        status: 'pending',
        exit_code: null,
        timed_out: false,
        duration_ms: undefined,
      },
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function boolLabel(v: boolean | null): string {
  if (v === null) return '—';
  return v ? 'ok' : 'fail';
}
