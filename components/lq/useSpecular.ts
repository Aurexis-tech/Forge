'use client';

// useSpecular — drives the cursor-tracking specular highlight on a
// LiquidGlass surface. It writes two CSS custom properties on the element,
// --mx / --my, which the `.glass::after` radial-gradient reads as its
// centre. Part of the DORMANT AI-futuristic design language; nothing
// mounts it yet.
//
// SSR-safe: 'use client' + the effect only runs in the browser (guards
// window / the ref). Reduced-motion: the specular highlight is pointer-
// driven (not an infinite loop), so it stays — the discipline only asks
// us to drop the hover *transform lift*, which the CSS handles via a
// prefers-reduced-motion rule in LiquidGlass.module.css.

import { useEffect, useRef } from 'react';

/** The neutral, centred specular position used before any pointer move
 *  and after the pointer leaves. */
export const SPECULAR_RESET = { mx: '50%', my: '50%' } as const;

/**
 * PURE: the specular centre as px offsets of the pointer from an
 * element's bounding rect. Exported so the math is unit-testable without
 * a DOM (the repo's test env is node-only).
 */
export function specularOffset(
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
): { mx: number; my: number } {
  return { mx: clientX - rect.left, my: clientY - rect.top };
}

/**
 * Attach pointer tracking to an element ref. On pointermove it sets
 * --mx/--my (px); on pointerleave it resets to 50%/50%. Pass
 * `enabled = false` (e.g. the disabled variant) to skip wiring entirely.
 */
export function useSpecular<T extends HTMLElement = HTMLElement>(
  enabled = true,
) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    const el = ref.current;
    if (!el) return;

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const { mx, my } = specularOffset(rect, e.clientX, e.clientY);
      el.style.setProperty('--mx', `${mx}px`);
      el.style.setProperty('--my', `${my}px`);
    };
    const onLeave = () => {
      el.style.setProperty('--mx', SPECULAR_RESET.mx);
      el.style.setProperty('--my', SPECULAR_RESET.my);
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [enabled]);

  return ref;
}
