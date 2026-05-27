'use client';

// Kicks off the Phase 3 (Software) codegen. Mirrors
// GenerateSystemBuildPanel from the system path; only the endpoint +
// copy + slot-count framing differ.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { NeedsKeyGate } from '@/components/keys/NeedsKeyGate';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  failedMessage?: string | null;
  // Slot tally surfaced in the kickoff copy so the user knows what
  // they're about to materialise.
  pageCount: number;
  entityCount: number;
}

export function GenerateSoftwareBuildPanel({
  projectId,
  failedMessage,
  pageCount,
  entityCount,
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
        '/api/projects/' + projectId + '/software/build/generate',
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
      setError(err instanceof Error ? err.message : 'Failed to generate the software build.');
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            software codegen · stage 03
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Materialise the vetted Next.js + Supabase scaffold, emit an
            RLS-enabled migration for every entity ({entityCount}), then fill
            each LLM slot — API handlers per CRUD method, page components per
            page ({pageCount}). The scaffold itself ships the Supabase Auth
            slot + session middleware; the LLM never re-authors auth, and
            every file is statically checked by esbuild before storage.
            Nothing is executed at this layer.
          </p>
          <ul className="mt-2 list-inside list-disc text-xs text-forge-dim">
            <li>No hand-rolled auth — Supabase Auth always.</li>
            <li>RLS on by default — every entity table.</li>
            <li>Service-role key never imported by any generated file.</li>
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
            onClick={onGenerate}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{submitting ? 'Filling slots…' : 'Generate software app'}</span>
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
