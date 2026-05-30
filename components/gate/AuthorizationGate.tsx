'use client';

// Reusable in-the-moment authorisation panel — the AI-futuristic gate
// moment. PRESERVES every real mechanism for every caller:
//   - The exact action is described in plain language at the top from the
//     real `title` the flow passes.
//   - `summary` is rendered as-given (string OR { label, value }) — the
//     gate renders only what the flow provides; nothing is fabricated
//     here (no invented dollar-impact rows, no invented scope badges).
//   - The Approve button stays disabled until the (optional) `requireText`
//     matches what the user types — same validation as before.
//   - `onApprove` fires unchanged (the flow posts to its real endpoint
//     and triggers router.refresh() on success).
//   - `onCancel` fires unchanged.
//   - `error` is the real backend error from the flow's failed POST.
//
// Restyle only: LiquidGlass `rose` variant for weight, lq.* tokens,
// --ink-base, font-ui on the heading, font-code on labels/eyebrows. ZERO
// infinite loops — gates shouldn't throb. The weight comes from the
// static rose accent + a one-shot mount fade (CSS module).
//
// Generic — works for every caller (push / deploy / runtime / provision /
// infra apply / infra confirm). No assumptions about which flow is using
// it; the disclosure prop shapes are the entire contract.

import { useState } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import styles from './gate.module.css';

export interface AuthorizationGateProps {
  title: string;
  summary: ReadonlyArray<string | { label: string; value: string }>;
  // Free-form helper text shown below the summary. Use for caveats.
  helper?: string;
  confirmLabel: string;
  cancelLabel?: string;
  // Optional safety: require the user to type a specific string before
  // the Approve button activates. Use for irreversible / heavyweight
  // actions. No current caller sets this — but the prop stays so a future
  // flow can opt in without changing the gate's shape.
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
    <LiquidGlass
      as="div"
      variant="rose"
      className={
        'flex flex-col gap-6 p-6 font-ui ' + styles.mountFade
      }
    >
      {/* Eyebrow row — authorisation required + human-in-the-loop chip. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-lq-rose"
          />
          <h2 className="font-code text-[10px] uppercase tracking-[0.4em] text-lq-rose">
            authorization required
          </h2>
        </div>
        <span className="rounded-full border border-lq-line bg-lq-elev-1 px-2 py-0.5 font-code text-[10px] uppercase tracking-[0.25em] text-lq-ink-faint">
          human in the loop
        </span>
      </div>

      {/* Title + the explicit "nothing happens until you click X" line. */}
      <div className="flex flex-col gap-2">
        <h3 className="font-ui text-xl font-semibold tracking-tight text-lq-ink">
          {title}
        </h3>
        <p className="text-sm leading-relaxed text-lq-ink-dim">
          Aurexis Forge will perform the following action ONLY after you
          approve it here. Nothing happens until you click{' '}
          <span className="text-lq-rose">{confirmLabel}</span>.
        </p>
      </div>

      {/* Real disclosure — rendered as the flow provided it. */}
      <ul className="flex flex-col gap-2 rounded-[14px] border border-lq-line bg-lq-elev-1 p-4">
        {summary.map((row, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span
              aria-hidden
              className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-lq-rose"
            />
            {typeof row === 'string' ? (
              <span className="text-lq-ink">{row}</span>
            ) : (
              <span className="flex flex-wrap items-baseline gap-2 text-lq-ink">
                <span className="font-code text-[10px] uppercase tracking-[0.25em] text-lq-ink-faint">
                  {row.label}
                </span>
                <span className="font-code text-[13px] text-lq-ink">
                  {row.value}
                </span>
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* Helper / caveat — only when the flow provides it. */}
      {helper ? (
        <p className="rounded-[10px] border border-lq-line bg-lq-elev-1 px-3 py-2 text-xs leading-relaxed text-lq-ink-dim">
          {helper}
        </p>
      ) : null}

      {/* Typed-confirmation field — only when the flow opts in. */}
      {requireText ? (
        <label className="flex flex-col gap-2">
          <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            type <span className="text-lq-rose">{requireText}</span> to confirm
          </span>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="rounded-[10px] border border-lq-line bg-white/[0.04] px-3 py-2 font-code text-sm text-lq-ink backdrop-blur-md transition placeholder:text-lq-ink-faint focus:border-lq-rose focus:outline-none focus:shadow-[inset_0_0_44px_-14px_rgba(244,63,94,0.4)] focus:ring-2 focus:ring-[rgba(244,63,94,0.25)]"
          />
        </label>
      ) : null}

      {/* Real backend error, when the flow's POST failed. */}
      {error ? (
        <p
          role="alert"
          className="rounded-[10px] border border-lq-rose/50 bg-lq-rose/10 px-3 py-2 text-sm text-lq-rose"
        >
          {error}
        </p>
      ) : null}

      {/* Deny (neutral LiquidGlass) + Authorize (rose LiquidGlass).
          Approve fires the real onApprove unchanged. */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-lq-line pt-4">
        {onCancel ? (
          <LiquidGlass
            as="button"
            type="button"
            onClick={() => !busy && onCancel()}
            disabled={busy}
            className="inline-flex items-center rounded-[14px] px-4 py-2 font-code text-[11px] uppercase tracking-[0.3em]"
          >
            {cancelLabel}
          </LiquidGlass>
        ) : null}
        <LiquidGlass
          as="button"
          type="button"
          onClick={approve}
          disabled={busy || !requireSatisfied}
          variant={busy || !requireSatisfied ? 'disabled' : 'rose'}
          className="inline-flex items-center gap-2 rounded-[14px] px-5 py-2.5 font-code text-[11px] uppercase tracking-[0.3em]"
        >
          <span>{busy ? 'Working…' : confirmLabel}</span>
          <span
            aria-hidden
            className={
              'inline-block h-1.5 w-1.5 rounded-full ' +
              (busy || !requireSatisfied ? 'bg-lq-ink-faint' : 'bg-lq-rose')
            }
          />
        </LiquidGlass>
      </div>
    </LiquidGlass>
  );
}
