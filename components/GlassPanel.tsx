// A crisp glassmorphic DOM container. Used by every overlay surface so the
// look stays consistent.

import { type HTMLAttributes, type ReactNode } from 'react';

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function GlassPanel({ children, className = '', ...rest }: GlassPanelProps) {
  return (
    <div
      {...rest}
      className={
        'relative rounded-2xl border border-white/10 bg-forge-panel p-8 ' +
        'shadow-glass backdrop-blur-md backdrop-saturate-150 ' +
        className
      }
    >
      <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-white/[0.04] to-transparent" />
      <div className="relative">{children}</div>
    </div>
  );
}
