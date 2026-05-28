'use client';

// Reveal-on-scroll — a thin wrapper that fades + lifts its children into
// place when they enter the viewport, matching the landing's calm motion.
// Reduced-motion users (and environments without IntersectionObserver)
// get the content immediately, fully visible — motion is never required
// to SEE anything.
//
// Usage: wrap a section in <Reveal> (optionally <Reveal delayMs={80}> to
// stagger). Server pages can render it around server children.

import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Reveal({
  children,
  delayMs = 0,
  className = '',
}: {
  children: ReactNode;
  delayMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) {
      setShown(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            obs.disconnect();
            break;
          }
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={delayMs ? { transitionDelay: delayMs + 'ms' } : undefined}
      className={
        'transition-all duration-700 ease-out motion-reduce:transition-none ' +
        (shown ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0') +
        (className ? ' ' + className : '')
      }
    >
      {children}
    </div>
  );
}
