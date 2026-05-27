'use client';

// Phase 4-5a confirm gate. Two shapes:
//
//   - Pure-create plan -> the standard AuthorizationGate (one click).
//     Reused verbatim from components/gate/AuthorizationGate.
//   - Destructive plan -> a TYPED CONFIRM input. The user must type
//     the exact `typed_phrase_required` string from the plan row
//     before the "Confirm destructive plan" button activates.
//     Server-side, the route layer ALSO verifies the typed phrase
//     exactly (constant-time compare). A click is NOT enough.
//
// POSTs to /api/projects/[id]/infra/build/confirm-plan with either
// `{ authorized: true }` (pure-create) or `{ authorized: true,
// typed_confirm: "<phrase>" }` (destructive). The server re-checks
// the typed phrase EVEN WHEN this client thinks it matches.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';
import type { PublicInfraPlan } from '@/lib/engine/infra/cloud/persistence';

interface Props {
  projectId: string;
  plan: PublicInfraPlan;
}

export function InfraConfirmPlanFlow({ projectId, plan }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  async function onApprove(typedConfirm?: string) {
    setBusy(true);
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/infra/build/confirm-plan',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            authorized: true,
            ...(typedConfirm ? { typed_confirm: typedConfirm } : {}),
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(
        err instanceof Error ? err.message : 'Failed to confirm the plan.',
      );
      setBusy(false);
    }
  }

  // --- Pure-create gate — single AuthorizationGate, no typed phrase
  if (!plan.destructive) {
    return (
      <AuthorizationGate
        title="Confirm this pure-create plan?"
        summary={[
          { label: 'create', value: String(plan.create_count) + ' resources' },
          { label: 'change', value: '0' },
          { label: 'destroy', value: '0' },
          {
            label: 'ceiling',
            value:
              plan.ceiling_verdict === 'within_budget'
                ? 'within budget'
                : 'no hard cap set',
          },
        ]}
        helper={
          'Confirming this plan moves the build to plan_confirmed (ready to apply). The apply itself is a SEPARATE gated step (P4-5b) — nothing will be written to your cloud here.'
        }
        confirmLabel="Confirm plan"
        cancelLabel="Not yet"
        onApprove={() => onApprove()}
        onCancel={() => {
          /* no-op — gate stays mounted until status changes */
        }}
        error={error}
      />
    );
  }

  // --- Destructive gate — typed-confirm input, exact-match required
  const required = plan.typed_phrase_required ?? '';
  const matches = typed.trim() === required && required.length > 0;

  return (
    <GlassPanel className="border-rose-400/50 shadow-amber">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-rose-400 shadow-amber"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-300">
              destructive confirm required
            </h2>
          </div>
          <span className="rounded-full border border-rose-400/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-rose-300">
            irreversible action
          </span>
        </div>

        <p className="text-sm text-forge-text/90">
          This plan will <span className="text-rose-300">change or destroy</span>{' '}
          existing resources. A click is not enough — type the exact phrase
          below to confirm.
        </p>

        <ul className="flex flex-col gap-1 rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 font-mono text-[11px] text-rose-100">
          <li>create · {plan.create_count}</li>
          <li>change · {plan.change_count}</li>
          <li>destroy / replace · {plan.destroy_count}</li>
        </ul>

        <DestructiveResourceList plan={plan} />

        <label className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
            type{' '}
            <code className="rounded bg-black/40 px-1 text-rose-200">
              {required}
            </code>{' '}
            to confirm
          </span>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            className="rounded-lg border border-rose-400/50 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-400/40"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={required}
          />
        </label>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          confirming moves build to plan_confirmed · apply (P4-5b) is still a
          separate gated step · nothing is written to cloud here
        </p>

        <div className="flex items-center justify-end gap-3 border-t border-white/5 pt-4">
          <button
            type="button"
            onClick={() => onApprove(typed.trim())}
            disabled={busy || !matches}
            className="inline-flex items-center gap-2 rounded-xl border border-rose-400/60 bg-rose-500/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-rose-300 shadow-amber transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{busy ? 'Confirming…' : 'Confirm destructive plan'}</span>
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400 shadow-amber"
            />
          </button>
        </div>
      </div>
    </GlassPanel>
  );
}

function DestructiveResourceList({ plan }: { plan: PublicInfraPlan }) {
  const destructive = plan.plan_diff.resources.filter(
    (r) =>
      r.action === 'destroy' ||
      r.action === 'replace' ||
      r.action === 'change',
  );
  if (destructive.length === 0) return null;
  return (
    <div className="rounded-lg border border-rose-400/30 bg-black/30 p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
        this will destroy / replace / change:
      </p>
      <ul className="mt-2 flex flex-col gap-1 font-mono text-[11px]">
        {destructive.map((r) => (
          <li key={r.address} className="flex flex-wrap items-baseline gap-2">
            <span
              className={
                'rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.2em] ' +
                (r.action === 'destroy'
                  ? 'bg-rose-500/30 text-rose-100'
                  : r.action === 'replace'
                    ? 'bg-forge-amber/30 text-forge-amber'
                    : 'bg-forge-amber/20 text-forge-amber')
              }
            >
              {r.action}
            </span>
            <span className="break-all text-rose-100">{r.address}</span>
            <span className="text-forge-dim">{r.type}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
