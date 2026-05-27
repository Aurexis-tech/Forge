'use client';

// Kicks off the Phase 4-4 preview + cost-ceiling check.
// Mirrors GenerateInfraBuildPanel from P4-3 — fully deterministic,
// no LLM, no cloud call.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  failedMessage?: string | null;
  // From the InfraBuildArea: how many composed module steps will be
  // previewed. Surfaced in the kickoff copy.
  stepCount: number;
  // True when the build is currently in 'preview_blocked' state —
  // drives a "raise your ceiling and retry" framing in the copy.
  isRetry?: boolean;
}

export function InfraPreviewPanel({
  projectId,
  failedMessage,
  stepCount,
  isRetry,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(failedMessage ?? null);

  async function onPreview() {
    setSubmitting(true);
    setError(null);
    setCoreState('thinking');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/infra/build/preview',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // 402 means OVER_BUDGET — the preview persisted, the page will
      // reload it as a 'preview_blocked' build status. The UI handles
      // the over-budget banner from there.
      if (res.status === 402) {
        setCoreState('error');
        router.refresh();
        return;
      }
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(
        err instanceof Error ? err.message : 'Failed to derive the preview.',
      );
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            infrastructure preview · stage 04
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Render a deterministic preview of what would be created across the{' '}
            <span className="text-forge-text">{stepCount}</span> composed
            module{stepCount === 1 ? '' : 's'} and estimate a monthly cost.
            Then compare the estimate against your project budget ceiling — if
            the estimate exceeds your cap, provisioning stays{' '}
            <span className="text-forge-amber">BLOCKED</span> until you raise
            the ceiling or trim the spec.
          </p>
          <ul className="mt-2 list-inside list-disc text-xs text-forge-dim">
            <li>
              <span className="text-forge-text">deterministic</span> — derived
              from the catalog + composed IaC. No LLM round.
            </li>
            <li>
              <span className="text-forge-text">inert</span> — no terraform
              plan / apply, no cloud API call, no credentials needed.
            </li>
            <li>
              <span className="text-forge-text">cost ceiling = gate</span> —
              the budget cap blocks the FORWARD action based on PROJECTED
              cost. The only such gate in the engine.
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
            onClick={onPreview}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              {submitting
                ? 'Deriving preview…'
                : isRetry
                  ? 'Retry preview with updated ceiling'
                  : 'Preview infrastructure & estimate cost'}
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
