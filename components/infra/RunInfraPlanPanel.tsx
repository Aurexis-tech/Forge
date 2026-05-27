'use client';

// Kicks off the Phase 4-5a real `terraform plan`. The panel mounts
// when the build is at status='previewed' AND the latest preview was
// within-budget — i.e. the P4-4 gate has already passed.
//
// On success the page re-loads with the persisted plan row + the
// confirm gate mounted underneath. On an over-budget verdict the
// server returns 402 — the route layer flips the build to
// 'plan_blocked' and the page re-loads with the over-budget banner.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  failedMessage?: string | null;
  // For the kickoff copy — number of plan steps in the composed
  // ProvisioningPlan so the user knows the rough size of the diff.
  stepCount: number;
}

export function RunInfraPlanPanel({
  projectId,
  failedMessage,
  stepCount,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(failedMessage ?? null);

  async function onRunPlan() {
    setSubmitting(true);
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/infra/build/plan',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // 402 → over-budget; the server persisted plan_blocked. Refresh
      // so the page re-renders with the verdict banner.
      if (res.status === 402) {
        setCoreState('error');
        router.refresh();
        return;
      }
      // 412 → no cloud connection; surface a clear hint.
      if (res.status === 412) {
        throw new Error(
          body.error ??
            'connect a cloud provider before running terraform plan',
        );
      }
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to run terraform plan.',
      );
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            terraform plan · stage 05a · read-only
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Run a REAL <code className="text-forge-text">terraform plan</code>{' '}
            against your live cloud state — the first real cloud call in this
            project. The plan reads provider state and renders the live diff
            over the {stepCount} composed module
            {stepCount === 1 ? '' : 's'}. <span className="text-forge-amber">Nothing is applied.</span>
          </p>
          <ul className="mt-2 list-inside list-disc text-xs text-forge-dim">
            <li>
              <span className="text-forge-text">read-only</span> — `terraform
              plan` only. No apply, no state mutation.
            </li>
            <li>
              <span className="text-forge-text">cost ceiling re-check</span>{' '}
              fires against the REAL plan (which may differ from the P4-4
              estimate).
            </li>
            <li>
              <span className="text-forge-text">destructive plans</span>{' '}
              require a server-verified TYPED confirm on the next screen.
            </li>
          </ul>
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <div>
          <button
            type="button"
            onClick={onRunPlan}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              {submitting
                ? 'Running terraform plan…'
                : 'Run terraform plan (read-only)'}
            </span>
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
