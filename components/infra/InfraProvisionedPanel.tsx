'use client';

// Phase 4-5b read-only view of a provisioned infra build. Shows:
//   - "live infrastructure" header + the ledger-billed monthly cost
//   - sanitised outputs (the CloudProvider sanitiser strips secret-
//     shaped strings before they reach this column; we still render
//     suspiciously-named keys as masked for defence in depth)
//   - the gated DESTROY/teardown control (typed-confirm input;
//     button stays disabled until the typed phrase matches; server
//     re-checks the phrase exactly)
//   - the "monitoring + teardown lands next" locked note (P4-6)
//
// SECURITY: this component receives a sanitised PublicInfraApply.
// The encrypted state blob never reaches the client; only the
// state_present boolean tells the UI whether a destroy is available.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';
import type { PublicInfraApply } from '@/lib/engine/infra/cloud/apply-persistence';
import type { PublicInfraPlan } from '@/lib/engine/infra/cloud/persistence';

interface Props {
  projectId: string;
  apply: PublicInfraApply;
  plan: PublicInfraPlan;
}

const MASK_KEY_RE = /^(secret|password|token|key|credential|api_key)$/i;

export function InfraProvisionedPanel({ projectId, apply, plan }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const required = plan.typed_phrase_required ?? '';
  const matches = typed.trim() === required && required.length > 0;

  async function onDestroy() {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/infra/build/destroy',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ typed_confirm: typed.trim() }),
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
      setError(err instanceof Error ? err.message : 'Destroy failed.');
      setBusy(false);
    }
  }

  return (
    <GlassPanel className="border-emerald-400/40 shadow-amber">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-amber"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-emerald-300">
              infrastructure · provisioned
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            phase 4-5b · live cloud
          </p>
        </div>

        <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-4 font-mono text-[12px]">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
            ledger billed · monthly accrued
          </p>
          <p className="mt-1 text-emerald-100">
            ${formatUsd(apply.billed_usd_per_month)}/mo
          </p>
          <p className="mt-2 text-[10px] text-forge-dim">
            {apply.resources_added} added · {apply.resources_changed} changed ·{' '}
            {apply.resources_destroyed} destroyed
          </p>
        </div>

        {/* --- Outputs ----------------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px]">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            outputs · sanitised at the provider boundary
          </p>
          {Object.keys(apply.outputs_sanitised).length === 0 ? (
            <p className="mt-2 text-forge-dim">
              this plan exposed no named outputs
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {Object.entries(apply.outputs_sanitised).map(([k, v]) => (
                <li
                  key={k}
                  className="flex flex-wrap items-baseline justify-between gap-2"
                >
                  <span className="text-forge-text">{k}</span>
                  <span className="break-all text-forge-text/90">
                    {MASK_KEY_RE.test(k)
                      ? '[redacted · secret-named key]'
                      : renderValue(v)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-forge-dim">
            terraform state is stored encrypted on the server. it is never
            returned in this response.
          </p>
        </div>

        {/* --- Gated destroy / teardown ----------------------------- */}
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
            teardown · irreversible · typed confirm required
          </p>
          <p className="mt-2 text-sm text-forge-text/90">
            Destroy tears down every resource this build created. A click is
            not enough — type{' '}
            <code className="rounded bg-black/40 px-1 text-rose-200">
              {required}
            </code>{' '}
            to confirm.
          </p>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={required}
            className="mt-3 w-full rounded-lg border border-rose-400/50 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-400/40"
          />
          {error ? (
            <p
              role="alert"
              className="mt-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={onDestroy}
              disabled={busy || !matches}
              className="inline-flex items-center gap-2 rounded-xl border border-rose-400/60 bg-rose-500/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-rose-300 shadow-amber transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>{busy ? 'Destroying…' : 'Destroy infrastructure'}</span>
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400 shadow-amber"
              />
            </button>
          </div>
        </div>

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · monitoring + scheduled teardown lands next (p4-6)
        </p>
      </div>
    </GlassPanel>
  );
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 100) return Math.round(n).toLocaleString('en-US');
  return (Math.round(n * 100) / 100).toFixed(2);
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '[unrenderable]';
  }
}
