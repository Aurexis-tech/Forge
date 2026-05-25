'use client';

// Reusable in-the-moment authorisation panel.
//
// Every action that touches the user's external accounts or spends real
// money MUST route through one of these. The panel is built to be hard to
// approve accidentally:
//
// - The exact action is described in plain language at the top
// - Summary lines spell out *what will happen*
// - Approve is the only path forward; Cancel is a no-op
// - The Approve button stays disabled until the (optional) `requireText`
//   matches what the user types
// - No silent re-approval: the parent decides when to mount/unmount this

import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';

export interface AuthorizationGateProps {
  title: string;
  summary: ReadonlyArray<string | { label: string; value: string }>;
  // Free-form helper text shown below the summary. Use for caveats.
  helper?: string;
  confirmLabel: string;
  cancelLabel?: string;
  // Optional safety: require the user to type a specific string before the
  // Approve button activates. Use for higher-blast-radius actions.
  requireText?: string;
  // Called when the user clicks Approve. Should perform the action and
  // refresh the page or update state.
  onApprove: () => Promise<void> | void;
  // Called when the user clicks Cancel. Should hide the gate.
  onCancel?: () => void;
  // External error (e.g. a push that failed); rendered prominently.
  error?: string | null;
}

export function AuthorizationGate({
  title,
  summary,
  helper,
  confirmLabel,
  cancelLabel = 'Cancel',
  requireText,
  onApprove,
  onCancel,
  error,
}: AuthorizationGateProps) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const requireSatisfied = !requireText || typed.trim() === requireText;

  async function approve() {
    if (busy || !requireSatisfied) return;
    setBusy(true);
    try {
      await onApprove();
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassPanel className="border-forge-amber/60 shadow-amber">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              authorisation required
            </h2>
          </div>
          <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim">
            human in the loop
          </span>
        </div>

        <div>
          <h3 className="text-xl font-medium text-forge-text">{title}</h3>
          <p className="mt-2 text-sm text-forge-dim">
            Aurexis Forge will perform the following action ONLY after you
            approve it here. Nothing happens until you click <span className="text-forge-amber">{confirmLabel}</span>.
          </p>
        </div>

        <ul className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-4">
          {summary.map((row, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span
                aria-hidden
                className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-forge-amber"
              />
              {typeof row === 'string' ? (
                <span className="text-forge-text/90">{row}</span>
              ) : (
                <span className="text-forge-text/90">
                  <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-forge-dim">
                    {row.label}
                  </span>
                  <span className="ml-2 font-mono text-forge-text">{row.value}</span>
                </span>
              )}
            </li>
          ))}
        </ul>

        {helper ? (
          <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-forge-dim">
            {helper}
          </p>
        ) : null}

        {requireText ? (
          <label className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              type <span className="text-forge-amber">{requireText}</span> to confirm
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/5 pt-4">
          {onCancel ? (
            <button
              type="button"
              onClick={() => !busy && onCancel()}
              disabled={busy}
              className="rounded-xl border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-white/30 hover:text-forge-text disabled:cursor-not-allowed disabled:opacity-60"
            >
              {cancelLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={approve}
            disabled={busy || !requireSatisfied}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{busy ? 'Working…' : confirmLabel}</span>
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-forge-amber shadow-amber"
            />
          </button>
        </div>
      </div>
    </GlassPanel>
  );
}
