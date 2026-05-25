'use client';

// Magnetic CTA — the button drifts a few pixels toward the cursor when
// it's near, then settles back. Calm, not jumpy. Falls back to a normal
// link under prefers-reduced-motion.

import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import { useReducedMotion } from './useReducedMotion';

interface Props {
  href: string;
  children: ReactNode;
  // Pull strength in pixels at the cursor's closest distance.
  strength?: number;
}

export function MagneticButton({ href, children, strength = 8 }: Props) {
  const ref = useRef<HTMLAnchorElement | null>(null);
  const reduced = useReducedMotion();

  function onMove(e: React.MouseEvent<HTMLAnchorElement>) {
    if (reduced) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Distance from cursor to button center, normalised by half-extent.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = (e.clientX - cx) / (r.width / 2);
    const dy = (e.clientY - cy) / (r.height / 2);
    el.style.transform =
      'translate(' + dx * strength + 'px, ' + dy * strength + 'px)';
  }

  function onLeave() {
    const el = ref.current;
    if (!el) return;
    el.style.transform = 'translate(0px, 0px)';
  }

  return (
    <Link
      ref={ref}
      href={href}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className="group relative inline-flex items-center gap-3 rounded-full border border-forge-amber/60 bg-gradient-to-br from-forge-amber/20 via-forge-amber/10 to-transparent px-7 py-3.5 font-mono text-xs uppercase tracking-[0.4em] text-forge-amber shadow-amber transition-[transform,box-shadow,background] duration-300 ease-out hover:bg-forge-amber/25 hover:shadow-[0_0_60px_-10px_rgba(255,154,77,0.6)] motion-reduce:transform-none"
    >
      <span aria-hidden className="absolute inset-0 rounded-full ring-1 ring-forge-amber/30 transition group-hover:ring-forge-amber/60" />
      <span className="relative">{children}</span>
      <span
        aria-hidden
        className="relative inline-block h-1.5 w-1.5 rounded-full bg-forge-amber shadow-amber transition group-hover:scale-150"
      />
    </Link>
  );
}
