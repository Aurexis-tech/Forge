'use client';

// Phase 4-6 monitoring dashboard for a provisioned infra build.
// Analogous to the software app dashboard, but for the riskiest
// mold:
//
//   - resources + masked outputs (encrypted state NEVER on the
//     payload — assert at the persistence boundary; the assembler
//     strips it by construction)
//   - accruing real cost vs the budget ceiling
//   - DRIFT status (in-sync / drifted / unknown / failed) with a
//     "check drift" button that re-runs read-only plan()
//   - the FREEZE banner: when the kill switch is active, the
//     project is frozen. NEVER auto-destroyed. Clearing the switch
//     unfreezes.
//   - lifecycle TTL reminder when the InfraSpec is ephemeral
//   - the gated TEARDOWN control (typed-confirm input; routes to
//     the existing /infra/build/destroy)
//
// SECURITY: this component receives ONLY InfraDashboardPayload. The
// payload TYPE has no encrypted-state field; the secret-named keys
// have already been masked at the assembler boundary.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';
import type { InfraDashboardPayload } from '@/lib/engine/infra/runtime/persistence';

interface Props {
  payload: InfraDashboardPayload;
}

export function InfraMonitorDashboard({ payload }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [driftBusy, setDriftBusy] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [killSwitchBusy, setKillSwitchBusy] = useState(false);
  const [killSwitchError, setKillSwitchError] = useState<string | null>(null);
  const [killSwitchReason, setKillSwitchReason] = useState<string>('');
  const [typed, setTyped] = useState('');
  const [tearBusy, setTearBusy] = useState(false);
  const [tearError, setTearError] = useState<string | null>(null);

  const required = payload.typed_phrase_required ?? '';
  const matches = typed.trim() === required && required.length > 0;
  const frozen = payload.frozen;

  async function onCheckDrift() {
    if (driftBusy) return;
    setDriftBusy(true);
    setDriftError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + payload.project_id + '/infra/runtime/check-drift',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setDriftError(
        err instanceof Error ? err.message : 'Drift check failed.',
      );
    } finally {
      setDriftBusy(false);
    }
  }

  async function onFreeze() {
    if (killSwitchBusy) return;
    setKillSwitchBusy(true);
    setKillSwitchError(null);
    setCoreState('working');
    try {
      const res = await fetch('/api/governance/killswitch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'project',
          scope_id: payload.project_id,
          reason:
            killSwitchReason.trim() ||
            'frozen from infrastructure monitor dashboard',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed');
      setKillSwitchReason('');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setKillSwitchError(
        err instanceof Error ? err.message : 'Failed to freeze.',
      );
    } finally {
      setKillSwitchBusy(false);
    }
  }

  async function onUnfreeze() {
    if (killSwitchBusy) return;
    setKillSwitchBusy(true);
    setKillSwitchError(null);
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
      setKillSwitchError(
        err instanceof Error ? err.message : 'Failed to unfreeze.',
      );
    } finally {
      setKillSwitchBusy(false);
    }
  }

  async function onTeardown() {
    if (!matches || tearBusy) return;
    setTearBusy(true);
    setTearError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + payload.project_id + '/infra/build/destroy',
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
      setTearError(
        err instanceof Error ? err.message : 'Teardown failed.',
      );
      setTearBusy(false);
    }
  }

  return (
    <GlassPanel
      className={
        frozen
          ? 'border-forge-amber/60 shadow-amber'
          : 'border-emerald-400/40 shadow-amber'
      }
    >
      <div className="flex flex-col gap-5">
        {/* --- Header ----------------------------------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={
                'inline-block h-2 w-2 rounded-full ' +
                (frozen
                  ? 'bg-forge-amber shadow-amber'
                  : 'bg-emerald-400 shadow-amber')
              }
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-emerald-300">
              {frozen
                ? 'infrastructure · monitored · frozen'
                : 'infrastructure · monitored · live'}
            </h2>
          </div>
          <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim">
            phase 4 · mold complete
          </span>
        </div>

        {/* --- Freeze banner ---------------------------------------- */}
        {frozen ? (
          <div className="rounded-lg border border-forge-amber/50 bg-forge-amber/10 p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
              kill switch · active · {payload.kill_switch.scope} · FROZEN
            </p>
            <p className="mt-2 text-sm text-forge-text/90">
              Further apply / change / drift-check is blocked. The Forge{' '}
              <span className="text-forge-amber">NEVER auto-destroys</span>{' '}
              standing infrastructure — your resources remain in the cloud
              and continue to accrue cost. Clear the kill switch to unfreeze,
              or run a typed-confirm teardown to remove them.
            </p>
            {payload.kill_switch.reason ? (
              <p className="mt-1 font-mono text-[11px] text-forge-amber/80">
                reason: {payload.kill_switch.reason}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* --- What this infrastructure is ------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            what this infrastructure is
          </p>
          <p className="mt-2 text-sm text-forge-text">{payload.summary.goal}</p>
          <ul className="mt-3 flex flex-wrap gap-3 font-mono text-[11px] text-forge-dim">
            <li>
              <span className="text-forge-text">
                {payload.summary.resource_count}
              </span>{' '}
              spec resources · {payload.resources_added} applied
            </li>
            <li>
              region:{' '}
              <span className="text-forge-text">
                {payload.region ?? 'unspecified'}
              </span>
            </li>
            <li>
              lifecycle:{' '}
              <span
                className={
                  payload.lifecycle === 'ephemeral'
                    ? 'text-forge-amber'
                    : 'text-forge-text'
                }
              >
                {payload.lifecycle}
              </span>
            </li>
          </ul>
        </div>

        {/* --- Ephemeral TTL reminder ------------------------------ */}
        {payload.summary.has_ephemeral_lifecycle ? (
          <div className="rounded-lg border border-forge-amber/40 bg-forge-amber/10 p-3 font-mono text-[11px] text-forge-amber">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em]">
              lifecycle: ephemeral
            </p>
            <p className="mt-1 text-forge-amber/90">
              The InfraSpec marked this infrastructure as ephemeral. The
              Forge does NOT auto-tear-down — when you&apos;re done, run a
              typed-confirm teardown below to stop the cost.
            </p>
          </div>
        ) : null}

        {/* --- Cost ----------------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4 font-mono text-[12px]">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            cost · monthly accrual + total to date
          </p>
          <p className="mt-1 text-forge-text">
            ${formatUsd(payload.billed_usd_per_month)}/mo
            <span className="text-forge-dim"> · accrued </span>
            ${formatUsd(payload.accrued_usd_total)}
            {payload.ceiling_limit_usd != null ? (
              <>
                <span className="text-forge-dim"> · cap </span>
                ${formatUsd(payload.ceiling_limit_usd)}/{payload.ceiling_period}
              </>
            ) : (
              <span className="text-forge-dim"> · no hard cap set</span>
            )}
          </p>
          {payload.ceiling_limit_usd != null ? (
            <p className="mt-2 text-[10px] text-forge-dim">
              if standing cost trends past the cap, the kill switch will trip
              and freeze the project. teardown still requires a typed
              confirm.
            </p>
          ) : null}
        </div>

        {/* --- Resources / outputs --------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px]">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            outputs · sanitised at the provider boundary
          </p>
          {Object.keys(payload.outputs_masked).length === 0 ? (
            <p className="mt-2 text-forge-dim">
              this provisioning produced no named outputs
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {Object.entries(payload.outputs_masked).map(([k, v]) => (
                <li
                  key={k}
                  className="flex flex-wrap items-baseline justify-between gap-2"
                >
                  <span className="text-forge-text">{k}</span>
                  <span className="break-all text-forge-text/90">
                    {renderValue(v)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-forge-dim">
            the terraform state itself is stored encrypted on the server.
            it is never returned in this payload.
          </p>
        </div>

        {/* --- Drift ----------------------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              drift · live cloud vs IaC
            </p>
            <span
              className={
                'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] ' +
                driftTone(payload.drift.verdict)
              }
            >
              {payload.drift.verdict}
            </span>
          </div>
          {payload.drift.verdict !== 'unknown' ? (
            <p className="mt-2 font-mono text-[11px] text-forge-dim">
              {payload.drift.create_count} create ·{' '}
              {payload.drift.change_count} change ·{' '}
              {payload.drift.destroy_count} destroy
              {payload.drift.checked_at ? (
                <span> · checked {payload.drift.checked_at.slice(0, 19)}</span>
              ) : null}
            </p>
          ) : (
            <p className="mt-2 text-sm text-forge-dim">
              drift hasn&apos;t been checked yet for this provisioning.
            </p>
          )}
          {driftError ? (
            <p
              role="alert"
              className="mt-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              {driftError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onCheckDrift}
            disabled={driftBusy || frozen}
            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-forge-cyan/60 bg-forge-cyan/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-cyan shadow-cyan transition hover:bg-forge-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{driftBusy ? 'Checking…' : 'Check drift (read-only)'}</span>
          </button>
          {frozen ? (
            <p className="mt-2 text-[10px] text-forge-amber">
              frozen · clear the kill switch to run a drift check
            </p>
          ) : null}
        </div>

        {/* --- Governance · freeze --------------------------------- */}
        <div className="rounded-lg border border-white/10 bg-black/30 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            governance · project kill switch (freeze)
          </p>
          {frozen ? (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-sm text-forge-text">
                Project is frozen. Clear the kill switch to allow forward
                actions again. Standing infrastructure is unchanged.
              </p>
              <button
                type="button"
                onClick={onUnfreeze}
                disabled={killSwitchBusy}
                className="inline-flex w-fit items-center gap-2 rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {killSwitchBusy ? 'Clearing…' : 'Clear kill switch (unfreeze)'}
              </button>
            </div>
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
                value={killSwitchReason}
                onChange={(e) => setKillSwitchReason(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
                placeholder="why is this project being frozen?"
              />
              <button
                type="button"
                onClick={onFreeze}
                disabled={killSwitchBusy}
                className="inline-flex w-fit items-center gap-2 rounded-xl border border-forge-amber/50 bg-forge-amber/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-amber transition hover:bg-forge-amber/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {killSwitchBusy ? 'Working…' : 'Freeze project'}
              </button>
              <p className="text-[10px] text-forge-dim">
                freeze blocks further apply / change / drift-check. it does{' '}
                <span className="text-forge-text">not</span> destroy
                resources.
              </p>
            </div>
          )}
          {killSwitchError ? (
            <p
              role="alert"
              className="mt-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              {killSwitchError}
            </p>
          ) : null}
        </div>

        {/* --- Gated teardown ------------------------------------- */}
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
            teardown · irreversible · typed confirm required
          </p>
          <p className="mt-2 text-sm text-forge-text/90">
            Teardown removes every resource this build created and stops the
            standing cost. A click is not enough — type{' '}
            <code className="rounded bg-black/40 px-1 text-rose-200">
              {required}
            </code>{' '}
            to confirm. The server re-checks the typed phrase exactly.
          </p>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={tearBusy}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={required}
            className="mt-3 w-full rounded-lg border border-rose-400/50 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-400/40"
          />
          {tearError ? (
            <p
              role="alert"
              className="mt-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              {tearError}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={onTeardown}
              disabled={tearBusy || !matches}
              className="inline-flex items-center gap-2 rounded-xl border border-rose-400/60 bg-rose-500/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-rose-300 shadow-amber transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>{tearBusy ? 'Tearing down…' : 'Tear down infrastructure'}</span>
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400 shadow-amber"
              />
            </button>
          </div>
        </div>

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          phase 4 (infrastructure) · mold complete · intake → monitored
        </p>
      </div>
    </GlassPanel>
  );
}

function driftTone(verdict: InfraDashboardPayload['drift']['verdict']): string {
  switch (verdict) {
    case 'in_sync':
      return 'border-emerald-400/40 text-emerald-300';
    case 'drifted':
      return 'border-forge-amber/40 text-forge-amber';
    case 'failed':
      return 'border-rose-400/40 text-rose-300';
    default:
      return 'border-white/15 text-forge-dim';
  }
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
