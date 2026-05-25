'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  status: 'active' | 'paused' | 'stopped' | 'errored' | string;
}

export function RuntimeControls({ projectId, status }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(action: string, coreOnFire: 'working' | 'active' | 'idle') {
    setError(null);
    setBusy(action);
    setCoreState(coreOnFire);
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/runtime/' + action,
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
      setCoreState('error');
    } finally {
      setBusy(null);
    }
  }

  const isActive = status === 'active';
  const isPaused = status === 'paused';
  const isErrored = status === 'errored';
  const isStopped = status === 'stopped';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {isActive ? (
          <ControlButton
            label={busy === 'pause' ? 'Pausing…' : 'Pause'}
            tone="cyan"
            disabled={busy != null}
            onClick={() => post('pause', 'idle')}
          />
        ) : null}
        {(isPaused || isErrored) ? (
          <ControlButton
            label={busy === 'resume' ? 'Resuming…' : 'Resume'}
            tone="amber"
            disabled={busy != null}
            onClick={() => post('resume', 'active')}
          />
        ) : null}
        {(isActive || isPaused) ? (
          <ControlButton
            label={busy === 'run-now' ? 'Running…' : 'Run now'}
            tone="cyan"
            disabled={busy != null}
            onClick={() => post('run-now', 'working')}
          />
        ) : null}
        {!isStopped ? (
          <ControlButton
            label={busy === 'stop' ? 'Stopping…' : 'Stop'}
            tone="dim"
            disabled={busy != null}
            onClick={() => post('stop', 'idle')}
          />
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ControlButton({
  label,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  tone: 'amber' | 'cyan' | 'dim';
  disabled: boolean;
  onClick: () => void;
}) {
  const t =
    tone === 'amber'
      ? 'border-forge-amber/60 bg-forge-amber/15 text-forge-amber shadow-amber hover:bg-forge-amber/25'
      : tone === 'cyan'
        ? 'border-forge-cyan/60 bg-forge-cyan/10 text-forge-cyan shadow-cyan hover:bg-forge-cyan/20'
        : 'border-white/10 text-forge-dim hover:border-white/30 hover:text-forge-text';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'rounded-xl border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] transition disabled:cursor-not-allowed disabled:opacity-60 ' +
        t
      }
    >
      {label}
    </button>
  );
}
