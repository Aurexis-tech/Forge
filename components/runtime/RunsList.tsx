'use client';

import { useState } from 'react';
import type { AgentRun, AgentRunLogLine } from '@/lib/types';

interface Props {
  runs: AgentRun[];
}

export function RunsList({ runs }: Props) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-forge-dim">
        No runs yet. The first tick will fire on schedule, or use{' '}
        <span className="text-forge-text">Run now</span> to trigger an
        immediate execution.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </ul>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  const tone = STATUS_TONE[run.status as keyof typeof STATUS_TONE] ?? STATUS_TONE.running;
  const logs = parseLogs(run.logs);

  return (
    <li className="rounded-lg border border-white/10 bg-black/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden className={'inline-block h-1.5 w-1.5 rounded-full ' + tone.dot} />
          <code className="font-mono text-[11px] text-forge-text/80">
            {run.id.slice(0, 8)}
          </code>
          <span
            className={
              'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] ' +
              tone.pill
            }
          >
            {run.status}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-forge-dim">
            {run.trigger}
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-forge-dim">
          <span>{formatDuration(run.duration_ms)}</span>
          <span>{formatTime(run.started_at)}</span>
          <span aria-hidden className={'transition ' + (open ? 'rotate-180' : '')}>
            ⌄
          </span>
        </div>
      </button>
      {open ? (
        <div className="border-t border-white/5 px-3 py-3">
          {run.error ? (
            <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/[0.07] p-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
                error
              </p>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-rose-200/90">
                {run.error}
              </pre>
            </div>
          ) : null}
          {run.output != null ? (
            <div className="mb-3 rounded-lg border border-white/10 bg-black/50 p-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                output
              </p>
              <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-forge-text/90">
                {safeStringify(run.output)}
              </pre>
            </div>
          ) : null}
          {logs.length > 0 ? (
            <div className="rounded-lg border border-white/10 bg-black/50">
              <p className="border-b border-white/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                captured logs · {logs.length} lines
              </p>
              <div className="max-h-72 overflow-y-auto p-2">
                <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                  {logs.map((l, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="shrink-0 text-forge-dim">
                        {(l.stream ?? '').padEnd(14, ' ')}
                      </span>
                      <span className="text-forge-text/90">{l.message}</span>
                    </div>
                  ))}
                </pre>
              </div>
            </div>
          ) : (
            <p className="text-xs text-forge-dim">No logs captured.</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

const STATUS_TONE = {
  running: {
    dot: 'bg-forge-amber animate-pulse',
    pill: 'border-forge-amber/40 text-forge-amber',
  },
  succeeded: {
    dot: 'bg-emerald-400',
    pill: 'border-emerald-400/40 text-emerald-300',
  },
  failed: {
    dot: 'bg-rose-400',
    pill: 'border-rose-400/50 text-rose-300',
  },
} as const;

function parseLogs(logs: AgentRun['logs']): AgentRunLogLine[] {
  if (!Array.isArray(logs)) return [];
  return (logs as unknown as AgentRunLogLine[]).filter(
    (l) => l && typeof l.message === 'string',
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}
