'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { NeedsKeyGate } from '@/components/keys/NeedsKeyGate';
import { StreamConsole } from '@/components/stream/StreamConsole';
import { useEventStream } from '@/lib/stream/client';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  failedMessage?: string | null;
}

export function GenerateSpecPanel({ projectId, failedMessage }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(failedMessage ?? null);
  // When the server returns 412 needs_key, we swap the panel for the
  // friendly NeedsKeyGate instead of showing an error.
  const [needsKey, setNeedsKey] = useState<null | 'anthropic' | 'e2b'>(null);

  const stream = useEventStream({
    onEvent: (e) => {
      if (e.kind === 'done') {
        setCoreState('idle');
        // Defer the refresh slightly so the user reads "done" before the
        // next stage renders.
        setTimeout(() => router.refresh(), 300);
      }
      if (e.kind === 'error') {
        // Streaming variant emits reason='needs_key:<provider>'.
        const m = /^needs_key:(anthropic|e2b)$/.exec(e.reason ?? '');
        if (m) {
          setCoreState('idle');
          setNeedsKey(m[1] as 'anthropic' | 'e2b');
          return;
        }
        setCoreState('error');
        setError(e.message);
      }
    },
    onClose: () => setSubmitting(false),
  });

  if (needsKey) {
    return (
      <NeedsKeyGate
        provider={needsKey}
        returnTo={'/projects/' + projectId}
      />
    );
  }

  async function onGenerate() {
    setSubmitting(true);
    setError(null);
    setCoreState('thinking');

    // Try the streaming variant first. If anything about the network or
    // response shape disagrees, fall back to the polling route.
    try {
      await stream.start('/api/projects/' + projectId + '/spec/generate/stream', {
        method: 'POST',
      });
      return;
    } catch (streamErr) {
      // Soft fall through.
      console.warn('[forge.spec] streaming variant failed, polling:', streamErr);
    }

    try {
      const res = await fetch('/api/projects/' + projectId + '/spec/generate', {
        method: 'POST',
      });
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
      setError(err instanceof Error ? err.message : 'Failed to generate spec.');
      setSubmitting(false);
    }
  }

  const showStream = stream.status !== 'idle';

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            spec extraction
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            Forge a structured AgentSpec from the raw prompt above. The
            extractor may ask 1–3 clarifying questions if your idea is
            ambiguous.
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

        {showStream ? (
          <StreamConsole
            title="spec · live progress"
            events={stream.events}
            status={stream.status}
          />
        ) : null}

        <div>
          <button
            type="button"
            onClick={onGenerate}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{submitting ? 'Extracting…' : 'Generate spec'}</span>
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
