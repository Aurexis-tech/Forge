// THE single source of truth for the forge's motion layer — durations,
// easings, and the reduced-motion shortcut. Components reference these by
// name (never magic numbers) so the whole system is tunable in one place.
//
// The CSS side mirrors these EXACT numbers as custom properties in
// app/globals.css (--motion-* / --ease-*) for keyframe-driven motion
// (the forge moment, stage warm, the loading heat-bar). Keep the two in
// sync — this module is the canonical source; globals.css is the mirror.
// See /docs/design-language.md §4.
//
// Motion discipline (committed):
//   - Bounded. Everything here SETTLES. The only continuous motion in the
//     app is the ambient ember + breathe in ForgeBackdrop.
//   - Purposeful. Each token maps to a meaning: forging, a stage changing,
//     a hover, an arrival.
//   - Reduced-motion honored. motionMs() collapses any duration to 0 when
//     the user asks for reduced motion — the SAME state change still
//     happens, just instantly.

/** Named durations, in milliseconds. */
export const MOTION = {
  /** The forge moment — the bounded heat surge on FORGE IT. ~1.5s. */
  forgeMoment: 1500,
  /** A pipeline stage cooling molten → cyan (and the new one warming). */
  stageCool: 600,
  /** Hover/focus heat warming in/out. Snappy. */
  hoverWarm: 180,
  /** The per-element fade+lift of a page-load reveal. */
  revealBase: 500,
  /** The stagger step between revealed elements (header → primary → …). */
  revealStep: 120,
  /** One cycle of the loading heat-bar (cool → ember → glow → cool). */
  heatBar: 1400,
} as const;

export type MotionToken = keyof typeof MOTION;

/** Named easings — cubic-bezier strings shared by JS + CSS. */
export const EASE = {
  /** Heat leaving — decelerates as it settles (cooling). */
  cool: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /** Heat arriving — a confident ease-in-out. */
  warm: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** The forge strike — the same settling curve as cool, reused by name. */
  forge: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

export type EaseToken = keyof typeof EASE;

/**
 * Does this environment ask for reduced motion? Guarded for SSR / test
 * (no `window`) — returns false there so the server never assumes motion
 * either way; the client re-reads on mount.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The reduced-motion shortcut every timed motion consults: returns 0 when
 * reduced motion is requested, otherwise the duration. Pass a MOTION token
 * name or a raw ms value. `reduced` can be supplied (e.g. from a hook /
 * test) to avoid re-reading the media query.
 */
export function motionMs(
  token: MotionToken | number,
  reduced: boolean = prefersReducedMotion(),
): number {
  const ms = typeof token === 'number' ? token : MOTION[token];
  return reduced ? 0 : ms;
}

/** The CSS custom-property name mirroring a duration token (globals.css). */
export function motionVar(token: MotionToken): string {
  // forgeMoment → var(--motion-forge-moment)
  const kebab = token.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  return `var(--motion-${kebab})`;
}
