'use client';

// Kicks off the Phase 4 (Infrastructure) IaC codegen. Mirrors
// GenerateSoftwareBuildPanel from the software path; only the
// endpoint + copy differ. The composer is fully deterministic — no
// LLM round — so no NeedsKeyGate path is needed.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  failedMessage?: string | null;
  // Surfaced in the kickoff copy: how many provisioning steps will
  // be composed into module blocks.
  stepCount: number;
  // The set of module ids the plan references — surfaced as a
  // closed-catalog reassurance ("composed from N vetted modules").
  moduleCount: number;
}

export function GenerateInfraBuildPanel({
  projectId,
  failedMessage,
  stepCount,
  moduleCount,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(failedMessage ?? null);

  async function onGenerate() {
    setSubmitting(true);
    setError(null);
    setCoreState('thinking');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/infra/build/generate',
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
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to generate the infrastructure build.',
      );
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            infrastructure codegen · stage 03
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Compose the approved plan into Terraform by instantiating{' '}
            <span className="text-forge-text">{stepCount}</span> vetted module
            block{stepCount === 1 ? '' : 's'} from the closed catalog (
            <span className="text-forge-text">{moduleCount}</span> distinct
            module{moduleCount === 1 ? '' : 's'} used). Wiring resolves
            deterministically — no freehand resource blocks, no LLM round, no
            cloud call.
          </p>
          <ul className="mt-2 list-inside list-disc text-xs text-forge-dim">
            <li>
              <span className="text-forge-text">composed from vetted modules only</span>{' '}
              — every block traces to a catalog id.
            </li>
            <li>
              <span className="text-forge-text">secure defaults</span> —
              private-by-default · TLS · least-privilege IAM · KMS.
            </li>
            <li>
              <span className="text-forge-text">nothing applied</span> — code +
              static parse only. No terraform plan / apply. No cloud API.
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
            onClick={onGenerate}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>
              {submitting ? 'Composing modules…' : 'Generate infrastructure'}
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
