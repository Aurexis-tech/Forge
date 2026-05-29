'use client';

// LiveDemo — the self-running pipeline demo on the Landing hero (right).
// A JS state machine plays the PURE script from lib/landing-demo.ts
// (typed intent → mold detection → 8-dot pipeline → hold Live → loop).
// NO infinite CSS drives the pipeline; the only looping CSS is the tiny
// aurora pulse dot + the streaming cursor (landing.module.css).
//
// prefers-reduced-motion: skip the typing + cycling and render the demo in
// its final LIVE state statically (demoFinalState()).

import { useEffect, useRef, useState } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import {
  DEMO_DETECT_PULSE_MS,
  DEMO_DETECT_SNAP_MS,
  DEMO_INTENT,
  DEMO_LIVE_HOLD_MS,
  DEMO_LIVE_INDEX,
  DEMO_MOLD,
  DEMO_STAGES,
  DEMO_TYPE_MS,
  demoFinalState,
  type DemoTone,
} from '@/lib/landing-demo';
import styles from './landing.module.css';

const TONE_BG: Record<DemoTone, string> = {
  aurora: 'bg-lq-aurora',
  mint: 'bg-lq-mint',
  amber: 'bg-lq-amber',
};
const TONE_TEXT: Record<DemoTone, string> = {
  aurora: 'text-lq-aurora',
  mint: 'text-lq-mint',
  amber: 'text-lq-amber',
};

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function LiveDemo() {
  const [typed, setTyped] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [moldDetected, setMoldDetected] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    // Reduced-motion: no typing, no cycling — land directly in the final
    // settled LIVE state and stop.
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      const f = demoFinalState();
      setTyped(f.typed);
      setMoldDetected(f.moldDetected);
      setActiveIndex(f.activeIndex);
      setElapsedMs(15_000);
      return;
    }

    cancelled.current = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    // Cycle timer — ticks while the demo runs; reset each loop.
    const timer = setInterval(() => {
      if (!cancelled.current) setElapsedMs((e) => e + 250);
    }, 250);

    async function loop() {
      while (!cancelled.current) {
        // reset
        setTyped('');
        setDetecting(false);
        setMoldDetected(false);
        setActiveIndex(-1);
        setStreaming(false);
        setElapsedMs(0);

        // 1. type the intent, char by char
        for (let i = 1; i <= DEMO_INTENT.length; i++) {
          if (cancelled.current) return;
          setTyped(DEMO_INTENT.slice(0, i));
          await sleep(DEMO_TYPE_MS);
        }

        // 2. detect the mold
        if (cancelled.current) return;
        setDetecting(true);
        await sleep(DEMO_DETECT_PULSE_MS);
        if (cancelled.current) return;
        setDetecting(false);
        setMoldDetected(true);
        await sleep(DEMO_DETECT_SNAP_MS);

        // 3. light the pipeline dot-by-dot, surfacing each stage card
        for (let s = 0; s < DEMO_STAGES.length; s++) {
          if (cancelled.current) return;
          const stage = DEMO_STAGES[s]!;
          setActiveIndex(s);
          setStreaming(Boolean(stage.streaming));
          // Intent (durationMs 0) gets a short hold so its dot reads.
          await sleep(stage.durationMs || 500);
        }

        // 4. hold on Live, then loop
        if (cancelled.current) return;
        await sleep(DEMO_LIVE_HOLD_MS);
      }
    }

    void loop();
    return () => {
      cancelled.current = true;
      clearInterval(timer);
    };
  }, []);

  const activeStage = activeIndex >= 0 ? DEMO_STAGES[activeIndex] : null;
  const showCard = activeStage && activeStage.card;

  return (
    <LiquidGlass as="div" className="w-full p-5 font-code text-[13px] sm:p-6">
      {/* Header: LIVE DEMO pill + AGENT tag (fades in) + cycle timer. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-lq-line px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.25em] text-lq-ink-dim">
            <span
              aria-hidden
              className={`inline-block h-1.5 w-1.5 rounded-full bg-lq-aurora ${styles.pulseDot}`}
            />
            Live demo
          </span>
          <span
            className={`text-[10px] font-semibold uppercase tracking-[0.25em] text-lq-aurora transition-opacity duration-500 ${
              moldDetected ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {DEMO_MOLD}
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.2em] text-lq-ink-faint">
          cycle · {mmss(elapsedMs)}
        </span>
      </div>

      {/* Intent line — types itself; cursor blinks while typing. */}
      <p className="mt-5 min-h-[3.25rem] leading-relaxed text-lq-ink">
        <span className="text-lq-ink-faint">&gt; </span>
        {typed}
        {activeIndex < DEMO_LIVE_INDEX ? (
          <span aria-hidden className={styles.cursor} />
        ) : null}
      </p>

      {/* Detection line. */}
      <p className="mt-1 text-[12px]">
        {moldDetected ? (
          <span className="text-lq-aurora">AGENT · detected</span>
        ) : detecting ? (
          <span className={`text-lq-ink-dim ${styles.pulseDot}`}>
            detecting mold…
          </span>
        ) : (
          <span className="text-lq-ink-ghost">awaiting intent</span>
        )}
      </p>

      {/* 8-dot pipeline. */}
      <ol className="mt-5 flex items-center justify-between gap-1">
        {DEMO_STAGES.map((stage, i) => {
          const isActive = i === activeIndex;
          const isDone = i < activeIndex;
          const dot = isActive
            ? `${TONE_BG[stage.tone]} ${styles.pulseDot}`
            : isDone
              ? `${TONE_BG[stage.tone]} opacity-60`
              : 'bg-lq-ink-ghost';
          return (
            <li
              key={stage.id}
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
            >
              <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
              <span
                className={`text-[8px] uppercase tracking-[0.15em] ${
                  isActive
                    ? TONE_TEXT[stage.tone]
                    : isDone
                      ? 'text-lq-ink-dim'
                      : 'text-lq-ink-ghost'
                }`}
              >
                {stage.label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Active stage card. */}
      <div className="mt-5 min-h-[3rem]">
        {showCard ? (
          <div className="rounded-[10px] border border-lq-line bg-lq-elev-1 px-3.5 py-3">
            <p className={`leading-relaxed ${TONE_TEXT[activeStage!.tone]}`}>
              {activeStage!.card}
              {streaming ? <span aria-hidden className={styles.cursor} /> : null}
            </p>
          </div>
        ) : null}
      </div>
    </LiquidGlass>
  );
}
