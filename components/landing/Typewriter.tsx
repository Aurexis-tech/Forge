'use client';

// Cycles through the four output types — one prompt per type — typing
// each in, pausing, then deleting back to empty. Pure DOM, no
// dependencies. Pauses + reveals the static current prompt under
// prefers-reduced-motion.

import { useEffect, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

export interface TypewriterPrompt {
  type: 'Agent' | 'System' | 'Software' | 'Infrastructure';
  text: string;
}

interface Props {
  prompts: ReadonlyArray<TypewriterPrompt>;
  // Inform the parent which prompt is currently being typed (so the
  // hero can show the matching output-type pill on demo completion).
  onIndexChange?: (index: number) => void;
  // ms per character — kept slow for restraint.
  speed?: number;
  // ms held at the fully-typed prompt before deleting.
  hold?: number;
}

export function Typewriter({
  prompts,
  onIndexChange,
  speed = 38,
  hold = 1800,
}: Props) {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const [shown, setShown] = useState('');
  const [phase, setPhase] = useState<'typing' | 'holding' | 'deleting'>(
    'typing',
  );

  // Static mode for reduced-motion: show the first prompt full-string,
  // cycle every few seconds with a fade rather than a type animation.
  useEffect(() => {
    if (!reduced) return;
    setShown(prompts[i]?.text ?? '');
    onIndexChange?.(i);
    const t = setTimeout(() => setI((n) => (n + 1) % prompts.length), 4200);
    return () => clearTimeout(t);
  }, [reduced, i, prompts, onIndexChange]);

  // Animated mode.
  useEffect(() => {
    if (reduced) return;
    const target = prompts[i]?.text ?? '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (phase === 'typing') {
      onIndexChange?.(i);
      if (shown.length < target.length) {
        timer = setTimeout(
          () => setShown(target.slice(0, shown.length + 1)),
          speed,
        );
      } else {
        timer = setTimeout(() => setPhase('holding'), 50);
      }
    } else if (phase === 'holding') {
      timer = setTimeout(() => setPhase('deleting'), hold);
    } else {
      if (shown.length > 0) {
        timer = setTimeout(
          () => setShown(target.slice(0, shown.length - 1)),
          speed * 0.55,
        );
      } else {
        setI((n) => (n + 1) % prompts.length);
        setPhase('typing');
      }
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [reduced, phase, shown, i, prompts, speed, hold, onIndexChange]);

  return (
    <span className="inline-flex items-baseline">
      <span className="whitespace-pre-wrap text-forge-text/90">{shown}</span>
      <span
        aria-hidden
        className={
          'ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-forge-amber ' +
          (reduced ? 'opacity-0' : 'animate-pulse')
        }
      />
    </span>
  );
}
