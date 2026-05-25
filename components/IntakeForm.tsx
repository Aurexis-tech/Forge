'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { GlassPanel } from './GlassPanel';
import { useForgeStore } from '@/lib/store';

const EXAMPLES = [
  {
    title: 'Morning research brief',
    prompt:
      'A research assistant that every morning at 8am scans new arXiv papers in computer vision and emails me a 5-bullet brief of the most interesting ones.',
  },
  {
    title: 'Slack stand-up summariser',
    prompt:
      'An agent I can paste my team’s daily standup messages into; it returns a one-paragraph summary plus any blockers and follow-up actions.',
  },
  {
    title: 'GitHub triage helper',
    prompt:
      'A webhook that fires when a new issue is opened on my repo; it reads the issue, suggests labels and a likely owner, and posts a comment.',
  },
];

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
      setError('Describe the agent you want first.');
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
      <GlassPanel>
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              welcome · stage 01
            </p>
            <h1 className="mt-2 text-2xl font-medium text-forge-text sm:text-3xl">
              Describe the AI agent you want
            </h1>
            <p className="mt-2 text-sm text-forge-dim">
              Plain language. Be specific about what it does and who it&apos;s
              for — the Forge turns it into a structured spec, plan, code,
              tested sandbox, repo, and (when you approve) a live URL.
            </p>
          </div>

          <textarea
            aria-label="Agent description"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onFocus={() => setCoreState('active')}
            onBlur={() => setCoreState('idle')}
            rows={6}
            placeholder="e.g. A research assistant that scans new arXiv papers in computer vision every morning and emails me a 5-bullet brief."
            className="w-full resize-y rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-sm leading-relaxed text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            disabled={submitting}
          />

          {error ? (
            <p role="alert" className="text-sm text-rose-400">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              intent → spec → plan → code → sandbox → repo → deploy → live
            </span>
            <button
              type="submit"
              disabled={submitting}
              className="group relative inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-6 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>{submitting ? 'Forging…' : 'Forge it'}</span>
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-forge-amber shadow-amber transition group-hover:scale-150"
              />
            </button>
          </div>
        </form>
      </GlassPanel>

      <div className="mt-6 flex flex-col gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
          need a starting point? try one of these
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.title}
              type="button"
              onClick={() => setPrompt(ex.prompt)}
              disabled={submitting}
              className="flex flex-col gap-1 rounded-xl border border-white/10 bg-black/30 p-3 text-left transition hover:border-forge-cyan/40 hover:bg-black/40 disabled:opacity-60"
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan">
                {ex.title}
              </span>
              <span className="text-xs text-forge-text/80">{ex.prompt}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
