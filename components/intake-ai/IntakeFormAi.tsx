'use client';

// The AI-futuristic intake (/forge). The CREATE-FORGE wiring is preserved
// byte-for-byte from the forge IntakeForm: POST /api/projects with
// { raw_prompt } → push /projects/[id]. Only the shell is restyled
// (LiquidGlass + lq.* + Inter). The live mold hint is a PURE, free,
// client-side guess (lib/mold-hint) — the authoritative classification
// still happens server-side when the forge runs.

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { LiquidGlass, LiquidGlassButton } from '@/components/lq/LiquidGlass';
import { MOTION, motionMs } from '@/lib/forge-motion';
import { detectMoldHint, type MoldHint } from '@/lib/mold-hint';
import styles from './intake.module.css';

const EYEBROW = 'Welcome · Stage 01';
const HEADING = 'Describe what you want to build.';
const SUBCOPY =
  'An agent that watches the world for you. A system of agents working ' +
  'together. A full app with users and a database. A piece of ' +
  'infrastructure. The forge detects the mold as you type — keep it natural.';
const PLACEHOLDER =
  'e.g. Scan new arXiv computer-vision papers daily and email me a 5-bullet brief at 07:00 UTC.';
const EMPTY_ERROR = 'Describe what you want to build first.';

type Accent = 'aurora' | 'violet' | 'mint' | 'amber';

const HINT_META: Record<MoldHint, { label: string; dot: string; text: string }> = {
  agents: { label: 'Agent', dot: 'bg-lq-aurora', text: 'text-lq-aurora' },
  systems: { label: 'System', dot: 'bg-lq-violet', text: 'text-lq-violet' },
  software: { label: 'Software', dot: 'bg-lq-mint', text: 'text-lq-mint' },
  infrastructure: { label: 'Infrastructure', dot: 'bg-lq-amber', text: 'text-lq-amber' },
};

const STARTERS: ReadonlyArray<{ label: string; accent: Accent; dot: string; fill: string }> = [
  {
    label: 'Agent',
    accent: 'aurora',
    dot: 'bg-lq-aurora',
    fill: 'Scan new arXiv computer-vision papers daily and email me a 5-bullet brief at 07:00 UTC.',
  },
  {
    label: 'System',
    accent: 'violet',
    dot: 'bg-lq-violet',
    fill: 'Track our top 5 competitors — pricing pages, hiring, social posts — and surface weekly changes in a Monday digest.',
  },
  {
    label: 'Software',
    accent: 'mint',
    dot: 'bg-lq-mint',
    fill: 'Expense submission and approval app: employees submit receipts, managers approve, everyone sees status. Email notifications when something needs review.',
  },
  {
    label: 'Infrastructure',
    accent: 'amber',
    dot: 'bg-lq-amber',
    fill: 'A Postgres database for a 4-person team with row-level security, daily backups, and observability dashboards.',
  },
];

const PIPELINE = [
  'Intent',
  'Spec',
  'Plan',
  'Code',
  'Sandbox',
  'Repo',
  'Deploy',
  'Live',
];

export function IntakeFormAi() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [forging, setForging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live, free, provisional mold guess — UX only.
  const hint = detectMoldHint(prompt);

  // THE CREATE-FORGE ACTION — preserved exactly from the forge intake.
  async function startForge() {
    if (submitting) return;
    setError(null);
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError(EMPTY_ERROR);
      return;
    }
    setSubmitting(true);
    // Forge moment — bounded aurora surge, in parallel with the request
    // (never gates it; instant under reduced motion).
    setForging(true);
    window.setTimeout(() => setForging(false), motionMs(MOTION.forgeMoment));
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
      router.push('/projects/' + project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setSubmitting(false);
      setForging(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void startForge();
  }

  // ⌘↵ / Ctrl↵ triggers the same submit as the button.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void startForge();
    }
  }

  return (
    <div className="w-full max-w-2xl font-ui text-lq-ink">
      <LiquidGlass as="div" className="relative p-8">
        {/* Forge moment — bounded aurora surge over the acted-on surface. */}
        {forging ? (
          <div
            aria-hidden
            className={`${styles.surge} pointer-events-none absolute inset-0 z-10 rounded-[14px]`}
            style={{
              backgroundImage:
                'radial-gradient(60% 50% at 50% 42%, rgba(95,230,255,0.45), rgba(95,230,255,0.16) 45%, transparent 72%)',
            }}
          />
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          {/* Eyebrow + aurora hairline. */}
          <div className="flex items-center gap-3">
            <span className="font-code text-[11px] uppercase tracking-[0.35em] text-lq-aurora">
              {EYEBROW}
            </span>
            <span
              aria-hidden
              className="h-px w-10 bg-gradient-to-r from-lq-aurora to-transparent"
            />
          </div>

          {/* font-ui set DIRECTLY — beats the forge global h1→display rule. */}
          <div className="flex flex-col gap-3">
            <h1 className="font-ui text-4xl font-extrabold tracking-[-0.02em] text-lq-ink sm:text-5xl">
              {HEADING}
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-lq-ink-dim">
              {SUBCOPY}
            </p>
          </div>

          {/* Describe input — glass-styled; aurora inner glow on FOCUS only
              (overrides the global amber focus rule via class specificity). */}
          <textarea
            aria-label="Project description"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={6}
            placeholder={PLACEHOLDER}
            disabled={submitting}
            className="w-full resize-y rounded-[14px] border border-lq-line bg-white/[0.04] px-4 py-3.5 font-ui text-base leading-relaxed text-lq-ink backdrop-blur-md transition placeholder:text-lq-ink-faint focus:border-lq-aurora focus:outline-none focus:shadow-[inset_0_0_48px_-16px_rgba(95,230,255,0.5)] focus:ring-2 focus:ring-[rgba(95,230,255,0.28)] disabled:opacity-60"
          />

          {/* Meta row — live char counter + provisional mold hint. */}
          <div className="flex items-center justify-between gap-3">
            <span className="font-code text-[11px] text-lq-ink-faint">
              {prompt.length} chars
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-lq-line px-2.5 py-1 font-code text-[11px]">
              {hint ? (
                <>
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rounded-full ${HINT_META[hint].dot}`}
                  />
                  <span className="text-lq-ink-faint">looks like ·</span>
                  <span className={HINT_META[hint].text}>
                    {HINT_META[hint].label}
                  </span>
                </>
              ) : (
                // Neutral / abstain state — NOT an error look. The hint
                // is provisional; when signals are weak or two molds
                // both fire strongly (e.g. agent + system on a
                // competitor-watch prompt), we deliberately refuse to
                // commit and let the forge classify for real. The pulse
                // dot keeps it alive; the copy says "the forge decides."
                <>
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rounded-full bg-lq-ink-dim ${styles.pulseDot}`}
                  />
                  <span className="text-lq-ink-faint">mold set when you forge</span>
                </>
              )}
            </span>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-lq-rose">
              {error}
            </p>
          ) : null}

          {/* Forge it — the create-forge submit. ⌘↵ wired to the same path. */}
          <div className="flex items-center justify-end">
            <LiquidGlassButton type="submit" variant="aurora" disabled={submitting}>
              <span>{submitting ? 'Forging…' : 'Forge it'}</span>
              <kbd className="ml-1 rounded-md border border-white/25 px-1.5 py-0.5 font-code text-[10px] opacity-80">
                ⌘↵
              </kbd>
            </LiquidGlassButton>
          </div>

          {/* Idle pipeline strip — Intent lit aurora; the rest dim. Purely
              indicative; the lit dot's pulse is decorative (state is also
              conveyed by colour + label, so reduced-motion is fine). */}
          <ol className="flex items-center justify-between gap-1 border-t border-lq-line pt-5">
            {PIPELINE.map((label, i) => {
              const lit = i === 0;
              return (
                <li
                  key={label}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 rounded-full ${
                      lit ? `bg-lq-aurora ${styles.pulseDot}` : 'bg-lq-ink-ghost'
                    }`}
                  />
                  <span
                    className={`text-[8px] uppercase tracking-[0.15em] ${
                      lit ? 'text-lq-aurora' : 'text-lq-ink-ghost'
                    }`}
                  >
                    {label}
                  </span>
                </li>
              );
            })}
          </ol>
        </form>
      </LiquidGlass>

      {/* Starter chips — one per mold; each pre-fills the describe box (and
          the hint recomputes from the new text). */}
      <div className="mt-8 flex flex-col gap-3">
        <p className="font-code text-[10px] uppercase tracking-[0.4em] text-lq-ink-faint">
          need a starting point?
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {STARTERS.map((s) => (
            <LiquidGlass
              key={s.label}
              as="button"
              type="button"
              onClick={() => setPrompt(s.fill)}
              disabled={submitting}
              className="flex w-full flex-col gap-1.5 p-3.5 text-left font-ui disabled:opacity-60"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`inline-block h-1.5 w-1.5 rounded-full ${s.dot}`}
                />
                <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-dim">
                  {s.label}
                </span>
              </span>
              <span className="text-sm leading-relaxed text-lq-ink-dim">
                {s.fill}
              </span>
            </LiquidGlass>
          ))}
        </div>
      </div>
    </div>
  );
}
