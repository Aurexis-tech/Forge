'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  failedMessage?: string | null;
}

export function GeneratePlanPanel({ projectId, failedMessage }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(failedMessage ?? null);

  async function onGenerate() {
    setSubmitting(true);
    setError(null);
    setCoreState('thinking');
    try {
      const res = await fetch(`/api/projects/${projectId}/plan/generate`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Failed to generate plan.');
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            build plan · stage 02
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Turn the confirmed spec into a grounded build plan: scaffold,
            tools (mapped to the Forge's registry), planned files, env, and
            an acyclic task graph the build pipeline will execute.
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
            <span>{submitting ? 'Planning…' : 'Generate plan'}</span>
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
