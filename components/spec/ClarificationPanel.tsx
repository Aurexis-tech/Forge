'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  questions: string[];
}

export function ClarificationPanel({ projectId, questions }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const initial = useMemo(() => questions.map(() => ''), [questions]);
  const [answers, setAnswers] = useState<string[]>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const trimmed = answers.map((a) => a.trim());
    if (trimmed.some((a) => a.length === 0)) {
      setError('Please answer all questions.');
      return;
    }

    setSubmitting(true);
    setCoreState('thinking');
    try {
      const res = await fetch(`/api/projects/${projectId}/spec/clarify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          answers: questions.map((question, i) => ({
            question,
            answer: trimmed[i] ?? '',
          })),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Submission failed.');
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            clarification needed
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            The extractor needs a little more detail before it can lock in the
            spec.
          </p>
        </div>

        <ol className="flex flex-col gap-4">
          {questions.map((q, i) => (
            <li key={i} className="flex flex-col gap-2">
              <label className="text-sm text-forge-text">
                <span className="mr-2 font-mono text-[10px] text-forge-amber">
                  Q{i + 1}.
                </span>
                {q}
              </label>
              <textarea
                value={answers[i] ?? ''}
                onChange={(e) => {
                  const next = [...answers];
                  next[i] = e.target.value;
                  setAnswers(next);
                }}
                rows={2}
                disabled={submitting}
                className="w-full resize-y rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
                placeholder="Your answer…"
              />
            </li>
          ))}
        </ol>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Re-forging…' : 'Submit answers'}
          </button>
        </div>
      </form>
    </GlassPanel>
  );
}
