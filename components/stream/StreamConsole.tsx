'use client';

// Live progress console tied to a stage. Renders the SSE events with
// phase chips on top + a scrollable log beneath.

import type { StreamEvent } from '@/lib/stream/client';

interface Props {
  events: StreamEvent[];
  status: 'idle' | 'connecting' | 'streaming' | 'closed' | 'error';
  // Title shown above the chips, e.g. "Spec extraction".
  title: string;
}

const PHASE_TONE: Record<'started' | 'ok' | 'failed', string> = {
  started: 'border-forge-cyan/50 text-forge-cyan animate-pulse',
  ok: 'border-emerald-400/40 text-emerald-300',
  failed: 'border-rose-400/50 text-rose-300',
};

const LEVEL_TONE: Record<'info' | 'warn' | 'error' | 'default', string> = {
  info: 'text-forge-text/90',
  warn: 'text-amber-200',
  error: 'text-rose-300',
  default: 'text-forge-text/80',
};

export function StreamConsole({ events, status, title }: Props) {
  const phases = events.filter((e): e is Extract<StreamEvent, { kind: 'phase' }> => e.kind === 'phase');
  const phaseByName = new Map<string, 'started' | 'ok' | 'failed'>();
  for (const p of phases) phaseByName.set(p.name, p.status);

  const logLines = events.filter(
    (e): e is Extract<StreamEvent, { kind: 'log' | 'delta' | 'meta' | 'error' }> =>
      e.kind === 'log' || e.kind === 'delta' || e.kind === 'meta' || e.kind === 'error',
  );

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
          {title}
        </p>
        <StatusPill status={status} />
      </div>

      {phaseByName.size > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {[...phaseByName.entries()].map(([name, st]) => (
            <span
              key={name}
              className={
                'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] ' +
                PHASE_TONE[st]
              }
            >
              {name}
            </span>
          ))}
        </div>
      ) : null}

      <div className="max-h-56 overflow-y-auto rounded-lg border border-white/5 bg-black/60 p-2">
        {logLines.length === 0 ? (
          <p className="font-mono text-[10px] text-forge-dim">
            waiting for output…
          </p>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
            {logLines.map((e, i) => renderLine(e, i))}
          </pre>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Props['status'] }) {
  const tone =
    status === 'streaming'
      ? 'border-forge-cyan/50 text-forge-cyan animate-pulse'
      : status === 'closed'
        ? 'border-emerald-400/40 text-emerald-300'
        : status === 'error'
          ? 'border-rose-400/50 text-rose-300'
          : 'border-white/15 text-forge-dim';
  return (
    <span
      className={
        'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] ' +
        tone
      }
    >
      {status}
    </span>
  );
}

function renderLine(
  e: Extract<StreamEvent, { kind: 'log' | 'delta' | 'meta' | 'error' }>,
  i: number,
) {
  if (e.kind === 'log') {
    return (
      <div key={i} className={LEVEL_TONE[e.level ?? 'default']}>
        {e.message}
      </div>
    );
  }
  if (e.kind === 'delta') {
    return (
      <div key={i} className="text-forge-text/90">
        {e.section ? <span className="text-forge-cyan">[{e.section}] </span> : null}
        {e.text}
      </div>
    );
  }
  if (e.kind === 'meta') {
    return (
      <div key={i} className="text-forge-dim">
        {JSON.stringify(e.data)}
      </div>
    );
  }
  return (
    <div key={i} className="text-rose-300">
      ✗ {e.message}
      {e.reason ? <span className="ml-2 text-rose-400/80">({e.reason})</span> : null}
    </div>
  );
}
