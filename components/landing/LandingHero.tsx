'use client';

// The unforgettable moment. Centered oversized ForgeCore, drifting
// aurora behind, rising embers in front, a single input below with a
// typewriter cycling four example prompts, a scripted demo, and the
// ignition flare → live-agent card reveal.
//
// CRITICAL: anonymous visitors trigger ZERO API calls. Everything below
// is local state + setTimeouts. The "Start forging" CTA links to
// /sign-in.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Aurora } from './Aurora';
import { LivingBackdrop } from './LivingBackdrop';
import { LiveAgentCard } from './LiveAgentCard';
import { MagneticButton } from './MagneticButton';
import { Typewriter, type TypewriterPrompt } from './Typewriter';
import { useForgeStore } from '@/lib/store';
import { detectWebGL, prefersReducedMotion } from '@/lib/webgl';

// Lazy-load the canvas so WebGL-off / reduced-motion users never
// download the three.js bundle.
const HeroCanvas = dynamic(() => import('./HeroCanvas'), {
  ssr: false,
  loading: () => null,
});

const PROMPTS: ReadonlyArray<TypewriterPrompt> = [
  {
    type: 'Agent',
    text: 'A research assistant that emails me a 5-bullet brief of new arXiv computer-vision papers every morning at 8am.',
  },
  {
    type: 'System',
    text: 'A standup digest: paste my team’s daily messages and get a one-paragraph summary plus blockers and follow-ups.',
  },
  {
    type: 'Software',
    text: 'A simple recipe vault: I paste a URL, it extracts ingredients and steps, saves them, lets me search later.',
  },
  {
    type: 'Infrastructure',
    text: 'A cron that hits my staging URL every 5 minutes and pings me on Slack if it ever returns non-200.',
  },
];

type DemoPhase =
  | 'idle'
  // The user (or auto-run) committed the prompt.
  | 'committed'
  // Status lines stream in sequence.
  | 'planning'
  | 'writing'
  | 'testing'
  | 'approving'
  | 'deploying'
  // Ignition flare + card reveal.
  | 'ignited'
  | 'live';

const STATUS_LINES: Array<{ phase: DemoPhase; text: string }> = [
  { phase: 'planning',  text: 'planning the build…' },
  { phase: 'writing',   text: 'writing the code…' },
  { phase: 'testing',   text: 'testing it in a sandbox…' },
  { phase: 'approving', text: 'awaiting your approval (skipped in demo)…' },
  { phase: 'deploying', text: 'deploying…' },
];

export function LandingHero() {
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [canRender3D, setCanRender3D] = useState(false);

  // Detect WebGL + reduced-motion once on mount. The hero falls back to
  // a calm DOM treatment when either is true.
  useEffect(() => {
    const ok = detectWebGL() && !prefersReducedMotion();
    setCanRender3D(ok);
  }, []);

  // Track which prompt the typewriter is currently on, so the live-agent
  // card pill can match the prompt that just "forged".
  const [activePromptIndex, setActivePromptIndex] = useState(0);
  // Snapshot the prompt at the moment of demo commit — typewriter keeps
  // cycling silently during the demo, but the card needs the prompt the
  // user actually saw.
  const [demoType, setDemoType] = useState<TypewriterPrompt['type']>(
    PROMPTS[0]!.type,
  );

  const [phase, setPhase] = useState<DemoPhase>('idle');
  const [statusVisible, setStatusVisible] = useState<DemoPhase[]>([]);
  const [committedText, setCommittedText] = useState<string>('');
  // The hero input — controlled, but never sent anywhere.
  const [input, setInput] = useState('');
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const runDemo = useCallback(
    (overridePrompt?: string) => {
      clearTimers();
      const promptText =
        overridePrompt && overridePrompt.trim().length > 0
          ? overridePrompt.trim()
          : PROMPTS[activePromptIndex]?.text ?? '';
      const promptType = overridePrompt
        ? PROMPTS[activePromptIndex]?.type ?? 'Agent'
        : PROMPTS[activePromptIndex]?.type ?? 'Agent';
      setCommittedText(promptText);
      setDemoType(promptType);
      setStatusVisible([]);
      setPhase('committed');
      setCoreState('working');

      // Stagger the status lines across ~4.2s, then ignition, then live.
      const t = (ms: number, fn: () => void) =>
        timersRef.current.push(setTimeout(fn, ms));

      STATUS_LINES.forEach((line, i) => {
        t(700 + i * 700, () => {
          setStatusVisible((prev) => [...prev, line.phase]);
          setPhase(line.phase);
        });
      });
      // Ignition flare.
      t(700 + STATUS_LINES.length * 700 + 200, () => {
        setPhase('ignited');
        setCoreState('active');
      });
      // Live card reveal.
      t(700 + STATUS_LINES.length * 700 + 900, () => {
        setPhase('live');
      });
      // Settle the core after a beat.
      t(700 + STATUS_LINES.length * 700 + 3500, () => {
        setCoreState('idle');
      });
    },
    [activePromptIndex, clearTimers, setCoreState],
  );

  // Auto-run the demo once on mount so first-time visitors see the forge
  // happen without having to read instructions. Only fires once.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    const t = setTimeout(() => runDemo(), 2400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    runDemo(input);
  }

  const showIgnitionFlare = phase === 'ignited';
  const showLiveCard = phase === 'live';

  return (
    <section className="relative isolate flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-6 py-24">
      {/* Backdrop layers, deepest first. */}
      <Aurora />
      {canRender3D ? <HeroCanvas /> : <LivingBackdrop variant="hero" />}

      {/* Ignition flare overlay — a single bright pulse on demo finish. */}
      <div
        aria-hidden
        className={
          'pointer-events-none absolute inset-0 -z-0 ' +
          (showIgnitionFlare ? 'forge-ignition-active' : 'opacity-0')
        }
        style={{
          background:
            'radial-gradient(circle at 50% 45%, rgba(255,201,140,0.95), rgba(255,154,77,0.55) 30%, transparent 65%)',
        }}
      />

      {/* Foreground content. */}
      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center gap-10 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.55em] text-forge-amber/90">
          Agents · Systems · Software · Infrastructure
        </p>

        <h1 className="text-balance text-4xl font-medium leading-[1.1] text-forge-text sm:text-5xl md:text-6xl">
          Describe what you want.
          <br />
          <span className="text-forge-amber/95">The Forge builds it.</span>
        </h1>

        {/* The input is a real form, but it never POSTs. It just runs
            the local demo. Anonymous visitors never reach an API. */}
        <form
          onSubmit={onSubmit}
          className="w-full"
          aria-label="Forge demo input"
        >
          <div className="group flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-black/55 px-4 py-3 backdrop-blur-md transition focus-within:border-forge-amber/50 focus-within:bg-black/65">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-forge-amber shadow-amber"
            />
            {/* The typewriter renders as the placeholder when the input
                is empty. When the user types, we hide it. */}
            <div className="relative flex-1 text-left">
              {input.length === 0 && phase === 'idle' ? (
                <span className="pointer-events-none absolute inset-0 flex items-center font-mono text-sm text-forge-dim">
                  <Typewriter
                    prompts={PROMPTS}
                    onIndexChange={setActivePromptIndex}
                  />
                </span>
              ) : null}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="Describe what you want to forge"
                className="relative w-full bg-transparent font-mono text-sm text-forge-text placeholder:text-transparent focus:outline-none"
                placeholder={PROMPTS[activePromptIndex]?.text ?? ''}
              />
            </div>
            <button
              type="submit"
              className="shrink-0 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber transition hover:bg-forge-amber/25"
              aria-label="Run demo"
            >
              forge demo
            </button>
          </div>
          <p className="mt-3 text-center text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            anonymous demo · no api calls · sign in to forge for real
          </p>
        </form>

        {/* Status feed — visible only while the demo is in flight or live. */}
        {phase !== 'idle' ? (
          <div className="w-full max-w-xl text-left">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              your idea:
            </p>
            <p className="mb-4 text-pretty font-mono text-sm text-forge-text/90">
              {committedText}
            </p>
            <ul className="flex flex-col gap-1.5">
              {STATUS_LINES.map((line) => {
                const on = statusVisible.includes(line.phase);
                return (
                  <li
                    key={line.phase}
                    className={
                      'flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] transition-opacity duration-500 ' +
                      (on ? 'opacity-100' : 'opacity-30')
                    }
                  >
                    <span
                      aria-hidden
                      className={
                        'inline-block h-1.5 w-1.5 rounded-full ' +
                        (on
                          ? phase === 'live' || phase === 'ignited'
                            ? 'bg-forge-amber'
                            : 'bg-forge-cyan animate-pulse'
                          : 'bg-forge-dim/40')
                      }
                    />
                    <span
                      className={on ? 'text-forge-text/90' : 'text-forge-dim'}
                    >
                      {line.text}
                    </span>
                  </li>
                );
              })}
            </ul>

            <LiveAgentCard type={demoType} visible={showLiveCard} />
          </div>
        ) : null}

        <div className="mt-2 flex flex-col items-center gap-3">
          <MagneticButton href="/sign-in">Start forging</MagneticButton>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            magic link · no password
          </p>
        </div>
      </div>
    </section>
  );
}

// (Inline StaticCoreFallback was extracted into
// components/landing/LivingBackdrop.tsx so the authenticated app shell
// can reuse the same primitive without a second copy.)
