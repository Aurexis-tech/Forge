'use client';

// Single hook every landing component asks. Returns true when the user
// has prefers-reduced-motion enabled. SSR-safe (returns false on the
// server, settles after mount).

import { useEffect, useState } from 'react';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);
  return reduced;
}
