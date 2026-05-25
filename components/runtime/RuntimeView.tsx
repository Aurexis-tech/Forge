import { GlassPanel } from '@/components/GlassPanel';
import { describeCron } from '@/lib/engine/runtime/cron';
import type { AgentRun, AgentRuntime } from '@/lib/types';
import { RunsList } from './RunsList';
import { RuntimeControls } from './RuntimeControls';

interface Props {
  projectId: string;
  runtime: AgentRuntime;
  runs: AgentRun[];
}

const STATUS_TONE: Record<string, { dot: string; pill: string; border: string }> = {
  active: {
    dot: 'bg-forge-amber animate-pulse',
    pill: 'border-forge-amber/60 text-forge-amber',
    border: 'border-forge-amber/40',
  },
  paused: {
    dot: 'bg-forge-cyan',
    pill: 'border-forge-cyan/40 text-forge-cyan',
    border: 'border-forge-cyan/40',
  },
  errored: {
    dot: 'bg-rose-400',
    pill: 'border-rose-400/50 text-rose-300',
    border: 'border-rose-400/40',
  },
  stopped: {
    dot: 'bg-forge-dim',
    pill: 'border-white/15 text-forge-dim',
    border: 'border-white/15',
  },
};

export function RuntimeView({ projectId, runtime, runs }: Props) {
  const tone = STATUS_TONE[runtime.status] ?? STATUS_TONE.stopped!;
  const cadence = describeCron(runtime.schedule_cron);

  return (
    <GlassPanel className={tone.border + ' shadow-amber'}>
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span aria-hidden className={'inline-block h-2 w-2 rounded-full ' + tone.dot} />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              runtime · 24/7
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={
                'rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] ' +
                tone.pill
              }
            >
              {runtime.status}
            </span>
            <span className="rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              mode · {runtime.mode}
            </span>
          </div>
        </header>

        {runtime.status === 'errored' ? (
          <div className="rounded-lg border border-rose-400/40 bg-rose-500/[0.07] px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
              auto-paused
            </p>
            <p className="mt-1 text-sm text-rose-100/90">
              {runtime.consecutive_fails} consecutive failures hit the safety
              threshold. Investigate the most recent failed run below, then{' '}
              <span className="text-forge-text">Resume</span> when ready —
              this resets the failure counter.
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="cadence" value={cadence} mono />
          <Stat
            label="next run"
            value={
              runtime.status === 'active' && runtime.next_run_at
                ? formatTime(runtime.next_run_at)
                : '—'
            }
            mono
          />
          <Stat
            label="last run"
            value={runtime.last_run_at ? formatTime(runtime.last_run_at) : '—'}
            mono
          />
          <Stat
            label="runs"
            value={
              runtime.run_count +
              ' · ' +
              runtime.fail_count +
              ' fail' +
              (runtime.consecutive_fails > 0
                ? ' (' + runtime.consecutive_fails + ' streak)'
                : '')
            }
            mono
          />
        </div>

        <RuntimeControls projectId={projectId} status={runtime.status} />

        <section>
          <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            recent runs
          </h3>
          <div className="mt-2">
            <RunsList runs={runs} />
          </div>
        </section>

        {runtime.env_keys.length > 0 ? (
          <div className="rounded-lg border border-white/10 bg-black/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              env keys · {runtime.env_keys.length}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {runtime.env_keys.map((k) => (
                <code
                  key={k}
                  className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] text-forge-text/90"
                >
                  {k}
                </code>
              ))}
            </div>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              values are encrypted at rest; injected only into the isolated
              sandbox at run time
            </p>
          </div>
        ) : null}
      </div>
    </GlassPanel>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        {label}
      </p>
      <p
        className={
          'mt-1 text-sm text-forge-text ' + (mono ? 'font-mono text-xs' : '')
        }
      >
        {value}
      </p>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
