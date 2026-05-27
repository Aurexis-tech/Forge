'use client';

// Kicks off the Phase 2 (Systems) codegen. Mirrors the agent codegen
// kickoff panel (GenerateBuildPanel) — same NeedsKeyGate handling and
// state machine. Only the endpoint + copy differ.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { NeedsKeyGate } from '@/components/keys/NeedsKeyGate';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  nodeCount: number;
  failedMessage?: string | null;
}

export function GenerateSystemBuildPanel({
  projectId,
  nodeCount,
  failedMessage,
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

  async function onGenerate() {
    setSubmitting(true);
    setError(null);
    setCoreState('thinking');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/system/build/generate',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        provider?: string;
      };
      if (res.status === 412 && body.reason === 'needs_key') {
        setCoreState('idle');
        setNeedsKey((body.provider as 'anthropic' | 'e2b') ?? 'anthropic');
        setSubmitting(false);
        return;
      }
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Failed to generate the system build.');
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            system codegen · stage 03
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Generate an orchestrator plus one module per sub-agent ({nodeCount}{' '}
            module{nodeCount === 1 ? '' : 's'} total). The orchestrator is
            deterministic and bakes in the max-steps ceiling + handoff
            validation; per-module code is produced by the Phase 1 agent
            generator, called once per node. Every file is statically
            checked by esbuild — nothing is executed.
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
            onClick={onGenerate}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{submitting ? 'Forging modules…' : 'Generate system code'}</span>
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
