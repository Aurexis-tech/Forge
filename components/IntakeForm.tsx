'use client';

// The intake — the SHOWCASE for the forge design language. The page is
// calm (refined restraint): hairline surfaces, Spectral prose, mono
// labels, the lattice + embers breathing behind it. Heat is spent at ONE
// place — the FORGE IT action (ForgeButton) — plus a faint heat-glow that
// only appears while the describe box is focused (you're about to act).
// The StagePipeline below reads as the cooling spine: INTENT is molten
// (you're here), everything ahead is dim until you forge. Flow unchanged.

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { EmberCard } from '@/components/forge/EmberCard';
import { ForgeButton } from '@/components/forge/ForgeButton';
import { SectionHeader } from '@/components/forge/SectionHeader';
import { StagePipeline, CANONICAL_STAGES } from '@/components/forge/StagePipeline';
import { useForgeStore } from '@/lib/store';
import { INTAKE_COPY, INTAKE_EXAMPLES } from '@/lib/intake-content';

export function IntakeForm() {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError(INTAKE_COPY.emptyError);
      return;
    }
    setSubmitting(true);
    setCoreState('working');
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw_prompt: trimmed }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail || 'request failed (' + res.status + ')');
      }
      const { project } = (await res.json()) as { project: { id: string } };
      setCoreState('thinking');
      router.push('/projects/' + project.id);
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-2xl">
      <EmberCard tone="none" className="p-8">
        <form onSubmit={onSubmit} className="flex flex-col gap-7">
          <SectionHeader
            level={1}
            eyebrow={INTAKE_COPY.eyebrow}
            title={INTAKE_COPY.heading}
            subcopy={INTAKE_COPY.subcopy}
          />

          {/* Refined input — hairline by default; a faint inner heat-glow
              only on FOCUS (the page stays calm until you reach to act). */}
          <textarea
            aria-label={INTAKE_COPY.ariaLabel}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onFocus={() => setCoreState('active')}
            onBlur={() => setCoreState('idle')}
            rows={6}
            placeholder={INTAKE_COPY.placeholder}
            className="w-full resize-y rounded-xl border border-[color:var(--line)] bg-black/40 px-4 py-3 font-body text-base leading-relaxed text-forge-text transition placeholder:text-forge-dim/70 focus:border-heat-glow/60 focus:outline-none focus:shadow-[inset_0_0_44px_-14px_rgba(255,154,77,0.5)] focus:ring-2 focus:ring-heat-glow/20"
            disabled={submitting}
          />

          {error ? (
            <p role="alert" className="text-sm text-rose-400">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end">
            <ForgeButton type="submit" busy={submitting}>
              {submitting ? 'Forging…' : 'Forge it'}
            </ForgeButton>
          </div>

          {/* The cooling spine — at intake you're at INTENT (molten); the
              rest of the pipeline waits, dim, until you forge. */}
          <div className="border-t border-[color:var(--line)] pt-6">
            <StagePipeline stages={CANONICAL_STAGES} activeIndex={0} />
          </div>
        </form>
      </EmberCard>

      {/* Starter chips — quiet by default, a restrained heat tint on hover. */}
      <div className="mt-8 flex flex-col gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
          need a starting point? try one of these
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {INTAKE_EXAMPLES.map((ex) => (
            <button
              key={ex.mold}
              type="button"
              onClick={() => setPrompt(ex.prompt)}
              disabled={submitting}
              className="group flex flex-col gap-1.5 rounded-xl border border-[color:var(--line)] bg-black/30 p-3 text-left transition hover:border-heat-glow/30 hover:bg-black/40 hover:shadow-[0_0_30px_-10px_rgba(255,154,77,0.35)] disabled:opacity-60"
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan transition group-hover:text-heat-glow">
                {ex.title}
              </span>
              <span className="text-sm leading-relaxed text-forge-text/80">
                {ex.prompt}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
