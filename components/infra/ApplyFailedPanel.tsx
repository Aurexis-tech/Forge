'use client';

// Phase 4-5b read-only view of an apply that failed or was
// killswitched mid-flight. Surfaces:
//   - the failure reason (killswitched vs generic)
//   - the partial-state summary (resources that DID land)
//   - the GATED ROLLBACK control (typed-confirm input; same shape
//     as InfraProvisionedPanel's destroy gate)
//
// We NEVER auto-destroy a failed apply. The user must explicitly
// type the destroy phrase to roll back. The server re-verifies the
// typed phrase EXACTLY.

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

export function ApplyFailedPanel({ projectId, apply, plan }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const required = plan.typed_phrase_required ?? '';
  const matches = typed.trim() === required && required.length > 0;
  const canRollback = apply.state_present;

  async function onRollback() {
    if (!matches || busy || !canRollback) return;
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
      setError(err instanceof Error ? err.message : 'Rollback failed.');
      setBusy(false);
    }
  }

  return (
    <GlassPanel className="border-rose-400/50 shadow-amber">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-rose-400 shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-300">
            apply failed · partial state captured
          </h2>
        </div>

        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
            {apply.killswitched
              ? 'interrupted by the kill switch'
              : 'apply errored'}
          </p>
          {apply.error_message ? (
            <p className="mt-2 break-all font-mono text-[11px] text-rose-100">
              {apply.error_message}
            </p>
          ) : null}
          <ul className="mt-3 flex flex-col gap-1 font-mono text-[11px] text-rose-100">
            <li>resources that DID land · {apply.resources_added}</li>
            <li>changes that DID land · {apply.resources_changed}</li>
            <li>destroys that DID land · {apply.resources_destroyed}</li>
            <li>
              partial state captured ·{' '}
              {apply.state_present ? 'yes (encrypted at rest)' : 'no'}
            </li>
          </ul>
          <p className="mt-2 text-[10px] text-rose-200/80">
            The Forge NEVER auto-destroys. To roll back, type the destroy
            phrase below.
          </p>
        </div>

        <div className="rounded-lg border border-rose-400/30 bg-rose-500/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
            gated rollback · irreversible
          </p>
          {!canRollback ? (
            <p className="mt-2 text-sm text-rose-100/80">
              no captured state — rollback isn&apos;t available. you may need
              to clean up cloud resources manually.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-forge-text/90">
                Type{' '}
                <code className="rounded bg-black/40 px-1 text-rose-200">
                  {required}
                </code>{' '}
                to roll back. The server re-checks the typed phrase exactly.
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
                  onClick={onRollback}
                  disabled={busy || !matches}
                  className="inline-flex items-center gap-2 rounded-xl border border-rose-400/60 bg-rose-500/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-rose-300 shadow-amber transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span>{busy ? 'Rolling back…' : 'Roll back (destroy)'}</span>
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400 shadow-amber"
                  />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
