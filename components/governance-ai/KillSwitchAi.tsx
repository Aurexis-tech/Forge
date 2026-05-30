'use client';

// KillSwitchAi — the compact design-study kill switch panel. PRESERVES
// the real wiring byte-for-byte:
//   POST /api/governance/killswitch { scope:'global', reason:'manual' }  → engage
//   DELETE /api/governance/killswitch { scope:'global' }                  → clear
// Native confirm() is preserved on both sides (the prompt is part of the
// real safety posture). Only the SHELL + layout changes — compact rose-
// tinted panel with a power glyph on the left + a single Pull lever
// LiquidGlass rose button on the right.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { KILL_SWITCH_COPY } from '@/lib/governance-zones';
import { useForgeStore } from '@/lib/store';
import styles from './governance.module.css';

interface Props {
  active: boolean;
  reason: string | null;
  setBy: string | null;
  /** When the active kill-switch row was created — surfaced as "last
   *  pulled: <time>". Null when the system is in standby (no historical
   *  row is surfaced; we don't guess). */
  engagedAtIso: string | null;
}

export function KillSwitchAi({ active, reason, setBy, engagedAtIso }: Props) {
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

  // "last pulled" sub-line — real timestamp when active; "currently
  // standby" when not (the loader only surfaces ACTIVE rows, so we don't
  // claim "never" historically — we just describe the current state).
  const subLine = active
    ? engagedAtIso
      ? 'freezes every running project instantly · engaged ' +
        new Date(engagedAtIso).toLocaleString()
      : 'freezes every running project instantly · engaged'
    : 'freezes every running project instantly · currently standby';

  return (
    <LiquidGlass
      as="div"
      className={
        'flex flex-col gap-3 p-5 font-ui ' +
        (active ? styles.killSwitchPanelActive : styles.killSwitchPanel)
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden
            className={
              'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] ' +
              styles.killSwitchGlyph
            }
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5 text-lq-rose"
            >
              <path d="M12 2v10" />
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            </svg>
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
              Kill switch
            </h2>
            <p className="font-code text-[11px] uppercase tracking-[0.25em] text-lq-ink-dim">
              {subLine}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={
              'rounded-full border px-2.5 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] ' +
              (active
                ? 'border-lq-rose/60 bg-lq-rose/10 text-lq-rose'
                : 'border-lq-mint/40 bg-lq-mint/5 text-lq-mint')
            }
          >
            {active ? 'engaged' : 'standby'}
          </span>
          {active ? (
            <LiquidGlass
              as="button"
              type="button"
              onClick={release}
              disabled={busy}
              variant="aurora"
              className="inline-flex items-center rounded-[12px] px-4 py-2 font-code text-[11px] uppercase tracking-[0.25em]"
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
              className="inline-flex items-center rounded-[12px] px-4 py-2 font-code text-[11px] uppercase tracking-[0.25em]"
            >
              {busy ? 'engaging…' : KILL_SWITCH_COPY.engageCta}
            </LiquidGlass>
          )}
        </div>
      </div>

      {active ? (
        <p className="text-sm leading-relaxed text-lq-ink-dim">
          {KILL_SWITCH_COPY.engagedNow}
          {reason ? ' Reason: ' + reason + '.' : ''}
          {setBy ? ' Set by ' + setBy.slice(0, 8) + '.' : ''}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-[10px] border border-lq-rose/40 bg-lq-rose/10 px-3 py-2 text-sm text-lq-rose"
        >
          {error}
        </p>
      ) : null}
    </LiquidGlass>
  );
}
