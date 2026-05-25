'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';
import { TestView, type PhaseStatus } from './TestView';
import type { SandboxLogLine } from '@/lib/types';

interface Props {
  projectId: string;
  phases: PhaseStatus[];
  lines: SandboxLogLine[];
  buildOk: boolean | null;
  smokeOk: boolean | null;
  durationMs: number | null;
  provider: string;
  error: string | null;
}

export function TestFailedPanel({
  projectId,
  phases,
  lines,
  buildOk,
  smokeOk,
  durationMs,
  provider,
  error,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [retesting, setRetesting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [rxError, setRxError] = useState<string | null>(null);

  async function onRetest() {
    setRxError(null);
    setRetesting(true);
    setCoreState('working');
    try {
      const res = await fetch('/api/projects/' + projectId + '/build/test', {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setRxError(err instanceof Error ? err.message : 'Retest failed.');
      setRetesting(false);
    }
  }

  async function onRegenerate() {
    setRxError(null);
    setRegenerating(true);
    setCoreState('working');
    try {
      const res = await fetch('/api/projects/' + projectId + '/build/regenerate', {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setRxError(err instanceof Error ? err.message : 'Regenerate failed.');
      setRegenerating(false);
    }
  }

  const busy = retesting || regenerating;
  const failingPhase = phases.find((p) => p.status === 'failed')?.phase;

  return (
    <GlassPanel className="border-rose-400/40">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-rose-400"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-300">
              sandbox · failed
            </h2>
          </div>
          {failingPhase ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300/80">
              failing phase · {failingPhase}
            </p>
          ) : null}
        </div>

        <TestView
          phases={phases}
          lines={lines}
          buildOk={buildOk}
          smokeOk={smokeOk}
          durationMs={durationMs}
          provider={provider}
          error={error}
        />

        {rxError ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {rxError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/5 pt-4">
          <button
            type="button"
            onClick={onRetest}
            disabled={busy}
            className="rounded-xl border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-forge-cyan/50 hover:text-forge-cyan disabled:cursor-not-allowed disabled:opacity-60"
          >
            {retesting ? 'Retesting…' : 're-test'}
          </button>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {regenerating ? 'Re-forging…' : 'Regenerate code'}
          </button>
        </div>

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          to change the agent\'s intent or design, head back to the plan and refine it.
        </p>
      </div>
    </GlassPanel>
  );
}
