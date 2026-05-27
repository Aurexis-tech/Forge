'use client';

// Kicks off the Phase 3 (Software) sandbox test. Mirrors
// TestSystemBuildPanel from the system path; only the endpoint +
// copy + isolation-test framing differ.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { NeedsKeyGate } from '@/components/keys/NeedsKeyGate';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  failedMessage?: string | null;
  // Surfaced in copy: how many entity tables will be probed by the
  // cross-user A/B isolation test.
  entityCount: number;
  // Whether the spec requires auth — when false, isolation is
  // vacuously satisfied (no owner-scoped rows to leak), and we say
  // so up front so the reviewer isn't surprised by the result.
  requiresAuth: boolean;
  isRetry?: boolean;
}

export function TestSoftwareBuildPanel({
  projectId,
  failedMessage,
  entityCount,
  requiresAuth,
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
        '/api/projects/' + projectId + '/software/build/test',
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
      setError(err instanceof Error ? err.message : 'Failed to run software sandbox test.');
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            software sandbox · stage 04
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Spin up an isolated sandbox. Install dependencies, run{' '}
            <code className="text-forge-text">next build</code>, then stand up
            an ephemeral Postgres (pglite, in-process — network stays OFF) and
            apply the generated RLS migration. Two synthetic users A and B run
            against {entityCount} entity table
            {entityCount === 1 ? '' : 's'}: A inserts, B reads. <span className="text-forge-amber">The build PASSES iff B sees zero of A&apos;s owner-scoped rows.</span> The sandbox is{' '}
            <span className="text-forge-text">always destroyed</span> when the
            run ends. No real network, no real secrets, no real spend.
          </p>
          {!requiresAuth ? (
            <p className="mt-2 text-xs text-forge-dim">
              Spec auth is off → no owner-scoped rows → isolation test
              passes vacuously. The build step still runs in full.
            </p>
          ) : null}
          <p className="mt-2 text-xs text-forge-dim">
            If the BUILD step fails with a fixable LLM slot, the harness will
            attempt <em>one</em> bounded self-heal — regenerate that slot and
            re-test. <span className="text-rose-300">Isolation failures are a HARD STOP</span> and never self-heal.
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
                  : 'Run software sandbox test'}
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
