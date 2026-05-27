'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';
import { BuildView } from './BuildView';
import type { StaticStatus } from './FileTree';
import type { BuildFile } from '@/lib/types';

interface StaticCheckEntry {
  path: string;
  status: StaticStatus;
  error?: string;
}

interface Props {
  projectId: string;
  files: BuildFile[];
  staticChecks: StaticCheckEntry[];
  warnings: string[];
  failedCount: number;
}

export function GeneratedBuildPanel({
  projectId,
  files,
  staticChecks,
  warnings,
  failedCount,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRegenerate() {
    setError(null);
    setRegenerating(true);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/build/regenerate',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Regenerate failed.');
      setRegenerating(false);
    }
  }

  return (
    <GlassPanel className="border-forge-amber/30 shadow-amber">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              code · generated
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            ready for sandbox testing (next stage)
          </p>
        </div>

        <BuildView
          files={files}
          staticChecks={staticChecks}
          warnings={warnings}
        />

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            {files.length} files · {failedCount} failed static check
          </p>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            className="rounded-xl border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-forge-amber/50 hover:text-forge-amber disabled:cursor-not-allowed disabled:opacity-60"
          >
            {regenerating ? 'Re-forging…' : 'regenerate'}
          </button>
        </div>
      </div>
    </GlassPanel>
  );
}
