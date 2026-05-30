'use client';

// KillSwitchAi — the AI-futuristic kill switch panel. PRESERVES the wiring
// of the forge KillSwitchPanel byte-for-byte:
//   POST /api/governance/killswitch { scope:'global', reason:'manual' }  → engage
//   DELETE /api/governance/killswitch { scope:'global' }                  → clear
// Native confirm() is preserved (the prompt is part of the real safety
// posture — clicking the lever must not silently engage). Only the SHELL
// changes: LiquidGlass surface, lq.* tokens, font-ui, AI palette.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { KILL_SWITCH_COPY } from '@/lib/governance-zones';
import { useForgeStore } from '@/lib/store';

interface Props {
  active: boolean;
  reason: string | null;
  setBy: string | null;
}

export function KillSwitchAi({ active, reason, setBy }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function engage() {
    if (!confirm(KILL_SWITCH_COPY.engageConfirm)) return;
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
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Engage failed.');
      setCoreState('idle');
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    if (!confirm(KILL_SWITCH_COPY.clearConfirm)) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/governance/killswitch', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'global' }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Release failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LiquidGlass
      as="div"
      className={
        'flex flex-col gap-4 p-6 font-ui ' +
        (active
          ? 'border-l-2 border-l-lq-rose shadow-[0_0_44px_-8px_rgba(244,63,94,0.55)]'
          : 'border-l-2 border-l-lq-amber/60')
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-code text-[10px] uppercase tracking-[0.4em] text-lq-amber">
          {KILL_SWITCH_COPY.eyebrow}
        </span>
        <span
          className={
            'rounded-full border px-3 py-1 font-code text-[10px] uppercase tracking-[0.3em] ' +
            (active
              ? 'border-lq-rose/60 bg-lq-rose/10 text-lq-rose'
              : 'border-lq-mint/40 bg-lq-mint/5 text-lq-mint')
          }
        >
          {active ? 'engaged' : 'standby'}
        </span>
      </div>

      <h2 className="font-ui text-xl font-bold tracking-tight text-lq-ink">
        {KILL_SWITCH_COPY.headline}
      </h2>

      {active ? (
        <div className="rounded-[14px] border border-lq-rose/40 bg-lq-rose/[0.08] p-4">
          <p className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-rose">
            system paused
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-lq-ink-dim">
            {KILL_SWITCH_COPY.engagedNow}
            {reason ? ' Reason: ' + reason + '.' : ''}
            {setBy ? ' Set by ' + setBy.slice(0, 8) + '.' : ''}
          </p>
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-lq-ink-dim">
          {KILL_SWITCH_COPY.engagedMechanism}
        </p>
      )}

      {error ? (
        <p
          role="alert"
          className="rounded-[10px] border border-lq-rose/40 bg-lq-rose/10 px-3 py-2 text-sm text-lq-rose"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end">
        {active ? (
          <LiquidGlass
            as="button"
            type="button"
            onClick={release}
            disabled={busy}
            variant="aurora"
            className="inline-flex items-center rounded-[14px] px-5 py-2 font-code text-[11px] uppercase tracking-[0.25em]"
          >
            {busy ? 'releasing…' : KILL_SWITCH_COPY.clearCta}
          </LiquidGlass>
        ) : (
          <LiquidGlass
            as="button"
            type="button"
            onClick={engage}
            disabled={busy}
            variant="rose"
            className="inline-flex items-center rounded-[14px] px-5 py-2 font-code text-[11px] uppercase tracking-[0.25em]"
          >
            {busy ? 'engaging…' : KILL_SWITCH_COPY.engageCta}
          </LiquidGlass>
        )}
      </div>
    </LiquidGlass>
  );
}
