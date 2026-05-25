'use client';

// The prominent control. ACTIVATING is one click + a simple confirm —
// safety should be easy to engage. CLEARING also confirms because resuming
// is what re-opens the spend valve.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';

interface Props {
  active: boolean;
  reason: string | null;
  setBy: string | null;
}

export function KillSwitchPanel({ active, reason, setBy }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    if (!confirm('Activate the global kill switch? All ticks and new cost-incurring actions will be blocked until you clear it.')) {
      return;
    }
    setError(null);
    setBusy(true);
    setCoreState('error');
    try {
      const res = await fetch('/api/governance/killswitch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global', reason: 'manual' }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activate failed.');
      setCoreState('idle');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm('Clear the global kill switch and resume cost-incurring actions?')) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/governance/killswitch', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global' }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear failed.');
    } finally {
      setBusy(false);
    }
  }

  void confirming;
  void setConfirming;

  return (
    <GlassPanel
      className={
        active ? 'border-rose-400/60 shadow-[0_0_40px_-6px_rgba(244,63,94,0.5)]' : 'border-amber-400/30'
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            kill switch · global
          </h2>
          <span
            className={
              'rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] ' +
              (active
                ? 'border-rose-400/60 text-rose-300'
                : 'border-emerald-400/40 text-emerald-300')
            }
          >
            {active ? 'engaged' : 'off'}
          </span>
        </div>

        {active ? (
          <div className="rounded-lg border border-rose-400/40 bg-rose-500/[0.07] p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
              system paused
            </p>
            <p className="mt-1 text-sm text-rose-100/90">
              All cron ticks and new cost-incurring actions are blocked.
              {reason ? ' Reason: ' + reason + '.' : ''}
              {setBy ? ' Set by ' + setBy.slice(0, 8) + '.' : ''}
            </p>
          </div>
        ) : (
          <p className="text-sm text-forge-dim">
            Engaging the kill switch immediately halts the scheduler and
            refuses every new cost-incurring action with a clear message.
            Clearing it resumes — active runtimes do not need
            re-activation.
          </p>
        )}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end">
          {active ? (
            <button
              type="button"
              onClick={clear}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-60"
            >
              {busy ? 'Clearing…' : 'Clear kill switch'}
            </button>
          ) : (
            <button
              type="button"
              onClick={activate}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl border border-rose-400/60 bg-rose-500/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-rose-300 transition hover:bg-rose-500/25 disabled:opacity-60"
            >
              {busy ? 'Engaging…' : 'Engage kill switch'}
            </button>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
