'use client';

// ForgeButton — the heat-glow action button. THE button for irreversible
// forge moments (FORGE IT, authorize, go live). Heat is spent here with
// conviction: a molten amber face that intensifies its glow on hover and
// presses hotter on :active. Everywhere else, restraint — so do NOT reach
// for ForgeButton for incidental actions (use a quiet bordered link).
//
// Reduced-motion: the global prefers-reduced-motion rule freezes the
// transitions, leaving a solid amber button (no glow animation) — exactly
// the spec. The component adds no infinite/looping animation of its own.
//
// A thin <button>; pass type="submit" for forms. The trailing spark dot
// is the ember that grows on hover.

import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ForgeButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** When true the button reads as working (used by the forge moment). */
  busy?: boolean;
}

export function ForgeButton({
  children,
  busy = false,
  className = '',
  disabled,
  ...rest
}: ForgeButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      data-busy={busy ? 'true' : undefined}
      className={
        'group relative inline-flex items-center gap-2 rounded-xl ' +
        'border border-heat-glow/60 bg-heat-glow/15 px-6 py-3 ' +
        'font-mono text-xs uppercase tracking-[0.3em] text-heat-glow ' +
        'shadow-amber transition ' +
        'hover:border-heat-molten/80 hover:bg-heat-glow/25 ' +
        'hover:shadow-[0_0_44px_-4px_rgba(255,154,77,0.6)] ' +
        'active:bg-heat-molten/30 ' +
        'active:shadow-[0_0_60px_-2px_rgba(255,186,115,0.75)] ' +
        'disabled:cursor-not-allowed disabled:opacity-60 ' +
        className
      }
    >
      <span>{children}</span>
      {busy ? (
        // Forge-themed loading: a thin bar whose heat sweeps cool → ember
        // → glow while the work is in flight. Frozen to a static heat
        // gradient under reduced-motion (still legible as "working").
        <span aria-hidden className="forge-heat-bar h-1 w-8" />
      ) : (
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-heat-glow shadow-amber transition group-hover:scale-150 group-hover:bg-heat-spark"
        />
      )}
    </button>
  );
}
