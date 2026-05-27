'use client';

// Phase 3-6 software app dashboard — the presentation surface for a
// live (or temporarily offline) software app. Analogous to the system
// graph view, but for the software mold:
//
//   - Live URL with open-app link (deployment health badge)
//   - Database status (schema applied ✓, anon-key wired,
//     service-role server-only — NEVER the actual key)
//   - Governance / kill-switch control (set or clear, project-scope)
//   - Plain-language summary from the SoftwareSpec (pages + entities)
//   - Honest cost dimensions: hosting + database, not a per-run number
//
// SECURITY: this component receives the SoftwareDashboardPayload from
// the persistence layer's `assembleSoftwareDashboard` helper. That
// payload's TYPE intentionally has no service-role-key field — the
// server-side helper strips it. The dashboard cannot leak what its
// props don't carry.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';
import type { SoftwareDashboardPayload } from '@/lib/engine/software/runtime/persistence';

interface Props {
  payload: SoftwareDashboardPayload;
}

export function SoftwareAppDashboard({ payload }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonDraft, setReasonDraft] = useState<string>('');

  const killActive = payload.kill_switch.active;
  const projectScopeKill =
    killActive && payload.kill_switch.scope === 'project';

  async function setProjectKill() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch('/api/governance/killswitch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'project',
          scope_id: payload.project_id,
          reason: reasonDraft.trim() || 'taken offline from app dashboard',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed');
      setReasonDraft('');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Failed to set kill switch.');
    } finally {
      setBusy(false);
    }
  }

  async function clearProjectKill() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch('/api/governance/killswitch', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'project',
          scope_id: payload.project_id,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Failed to clear kill switch.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassPanel
      className={
        payload.live
          ? 'border-emerald-400/40 shadow-amber'
          : 'border-forge-amber/40 shadow-amber'
      }
    >
      <div className="flex flex-col gap-5">
        {/* --- Header ---------------------------------------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={
                'inline-block h-2 w-2 rounded-full ' +
                (payload.live
                  ? 'bg-emerald-400 shadow-amber'
                  : 'bg-forge-amber shadow-amber')
              }
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-emerald-300">
              {payload.live ? 'software app · live' : 'software app · offline'}
            </h2>
          </div>
          <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim">
            phase 3 · mold complete
          </span>
        </div>

        {/* --- What this app is ----------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            what this app is
          </p>
          <p className="mt-2 text-sm text-forge-text">{payload.summary.goal}</p>
          <ul className="mt-3 flex flex-wrap gap-3 font-mono text-[11px] text-forge-dim">
            <li>
              <span className="text-forge-text">{payload.summary.pages}</span>{' '}
              page{payload.summary.pages === 1 ? '' : 's'}
            </li>
            <li>
              <span className="text-forge-text">{payload.summary.entities}</span>{' '}
              entit{payload.summary.entities === 1 ? 'y' : 'ies'} · RLS-scoped
            </li>
            <li>
              <span className="text-forge-text">
                {payload.summary.requires_auth ? 'auth required' : 'no auth'}
              </span>
            </li>
          </ul>
        </div>

        {/* --- Kill-switch banner --------------------------------------- */}
        {killActive ? (
          <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
              kill switch · active · {payload.kill_switch.scope}
            </p>
            <p className="mt-2 text-sm text-rose-100">
              The app is OFFLINE. Go-live is blocked until the switch is
              cleared. The runtime row was paused automatically on the next
              dashboard load.
            </p>
            {payload.kill_switch.reason ? (
              <p className="mt-1 font-mono text-[11px] text-rose-200/80">
                reason: {payload.kill_switch.reason}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* --- Vercel deploy ------------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              deploy · vercel
            </p>
            <span
              className={
                'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] ' +
                (payload.deployment_status === 'ready'
                  ? 'border-emerald-400/40 text-emerald-300'
                  : 'border-forge-amber/40 text-forge-amber')
              }
            >
              {payload.deployment_status ?? 'unknown'}
            </span>
          </div>
          {payload.deploy_url ? (
            <a
              href={payload.deploy_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-2 font-mono text-sm text-emerald-300 hover:underline"
            >
              {payload.deploy_url}
              <span aria-hidden>↗</span>
            </a>
          ) : (
            <p className="mt-2 text-sm text-forge-dim">no deploy url</p>
          )}
          {payload.repo_url ? (
            <p className="mt-2 font-mono text-[11px]">
              <span className="text-forge-dim">repo · </span>
              <a
                href={payload.repo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-forge-cyan hover:underline"
              >
                {payload.repo_url}
              </a>
            </p>
          ) : null}
          {payload.vercel_account_login ? (
            <p className="mt-1 font-mono text-[11px] text-forge-dim">
              vercel · @{payload.vercel_account_login}
            </p>
          ) : null}
        </div>

        {/* --- Database ------------------------------------------------- */}
        {payload.db ? (
          <div className="rounded-lg border border-white/10 bg-black/30 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                database · supabase · {payload.db.provider_kind}
              </p>
              <span
                className={
                  'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] ' +
                  (payload.db.migration_applied
                    ? 'border-emerald-400/40 text-emerald-300'
                    : 'border-rose-400/40 text-rose-300')
                }
              >
                {payload.db.migration_applied
                  ? 'schema applied ✓'
                  : 'migration missing'}
              </span>
            </div>
            <ul className="mt-3 flex flex-col gap-1.5 font-mono text-[11px]">
              <li className="flex flex-wrap items-baseline gap-2">
                <span className="text-forge-dim">supabase url</span>
                <a
                  href={payload.db.supabase_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-forge-cyan hover:underline"
                >
                  {payload.db.supabase_url}
                </a>
              </li>
              <li className="flex flex-wrap items-baseline gap-2">
                <span className="text-forge-dim">anon key</span>
                <span className="text-forge-text">
                  •••• {payload.db.anon_key_last4} · public · wired into browser
                </span>
              </li>
              <li className="flex flex-wrap items-baseline gap-2">
                <span className="text-forge-dim">service-role</span>
                <span className="text-forge-text">
                  •••• {payload.db.service_role_last4} · encrypted at rest ·{' '}
                  <span className="text-forge-amber">server-only</span>
                </span>
              </li>
            </ul>
          </div>
        ) : null}

        {/* --- Cost dimensions ----------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            cost dimensions · infra (no per-run llm tokens)
          </p>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-[11px]">
            {payload.cost_dimensions.map((d) => (
              <li key={d.label} className="flex flex-wrap items-baseline gap-2">
                <span className="text-forge-dim">{d.label}</span>
                <span className="text-forge-text">{d.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 font-mono text-[10px] text-forge-dim/80">
            The governance budget + kill switch still own the hard stop —
            triggering the kill switch takes the app offline immediately.
          </p>
        </div>

        {/* --- Kill switch control ------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            governance · kill switch (project scope)
          </p>
          {projectScopeKill ? (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-sm text-forge-text">
                Project kill switch is active. Clear it to restore go-live.
              </p>
              <button
                type="button"
                onClick={clearProjectKill}
                disabled={busy}
                className="inline-flex w-fit items-center gap-2 rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? 'Clearing…' : 'Clear project kill switch'}
              </button>
            </div>
          ) : killActive ? (
            <p className="mt-3 text-sm text-forge-dim">
              A {payload.kill_switch.scope} kill switch is active; clear it
              from the governance page to restore go-live.
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              <label
                htmlFor="kill-reason"
                className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim"
              >
                reason (optional)
              </label>
              <input
                id="kill-reason"
                type="text"
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-rose-400/60 focus:outline-none focus:ring-2 focus:ring-rose-400/30"
                placeholder="why is the app going offline?"
              />
              <button
                type="button"
                onClick={setProjectKill}
                disabled={busy}
                className="inline-flex w-fit items-center gap-2 rounded-xl border border-rose-400/50 bg-rose-500/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-rose-300 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? 'Working…' : 'Take app offline'}
              </button>
            </div>
          )}
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          phase 3 (software) · mold complete · intake → live
        </p>
      </div>
    </GlassPanel>
  );
}
