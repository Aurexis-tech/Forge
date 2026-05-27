'use client';

// Kicks off the Phase 2 (Systems) sandbox smoke test. Mirrors
// RunTestPanel from the agent path; only the endpoint + copy + 412
// NeedsKeyGate handling differ (the Phase 1 panel doesn't currently
// gate; we do here because the system route also returns 412 when
// E2B isn't connected).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { NeedsKeyGate } from '@/components/keys/NeedsKeyGate';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  failedMessage?: string | null;
  // Surfaced in the copy so the reviewer knows roughly how many
  // module-smoke rounds the orchestrator will walk.
  nodeCount: number;
  // True when the previous run failed AND already exhausted its single
  // self-heal — used to render a different button label so the
  // reviewer can choose to retry as a NEW run.
  isRetry?: boolean;
}

export function TestSystemBuildPanel({
  projectId,
  failedMessage,
  nodeCount,
  isRetry,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(failedMessage ?? null);
  const [needsKey, setNeedsKey] = useState<null | 'anthropic' | 'e2b'>(null);

  if (needsKey) {
    return (
      <NeedsKeyGate provider={needsKey} returnTo={'/projects/' + projectId} />
    );
  }

  async function onRun() {
    setSubmitting(true);
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/system/build/test',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        provider?: string;
      };
      if (res.status === 412 && body.reason === 'needs_key') {
        setCoreState('idle');
        setNeedsKey((body.provider as 'anthropic' | 'e2b') ?? 'e2b');
        setSubmitting(false);
        return;
      }
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Failed to run system sandbox test.');
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            system sandbox · stage 04
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Spin up an isolated, disposable sandbox. Install dependencies,
            real-compile the orchestrator + modules with{' '}
            <code className="text-forge-text">tsc</code>, then walk the full
            execution order ({nodeCount} module{nodeCount === 1 ? '' : 's'})
            with tools in mock mode. Every handoff is validated by the
            generated orchestrator; the max-steps ceiling can&apos;t be
            exceeded. The sandbox is{' '}
            <span className="text-forge-text">always destroyed</span> when
            the run ends. No real network, no real secrets, no real spend.
          </p>
          <p className="mt-2 text-xs text-forge-dim">
            If smoke fails with a single identifiable failing node, the
            harness will attempt <em>one</em> bounded self-heal — regenerate
            that node&apos;s module and re-test. Hard-capped at one retry.
          </p>
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
            onClick={onRun}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              {submitting
                ? 'Sealing chamber…'
                : isRetry
                  ? 'Retry sandbox test'
                  : 'Run system sandbox test'}
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
