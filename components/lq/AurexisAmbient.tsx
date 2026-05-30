// AurexisAmbient — the AI-futuristic global backdrop. LIVE: mounted on
// every migrated route through the AppBackdrop switch and directly on
// the public landing. Pure presentation (server component, no hooks).
//
// "Deep field" direction — near-black, a faint starfield, one focused
// central glow. Minimal, deep, cinematic.
//   .ambient   — fixed full-bleed root, z:-10, pointer-events: none,
//                deepened near-black base (#060709, darker than --void)
//                so the starfield reads.
//   .starfield — faint static dot layer built from layered radial-
//                gradient points (no images, no per-dot DOM). Mostly
//                white at low alpha + a couple in faint aurora. No
//                twinkle — static for the premium/minimal feel.
//   .focus     — a single soft aurora bloom centered behind the content
//                (~680×520, blur 140px, opacity ~0.10), gently breathing
//                (slow opacity drift only — no movement).
//   .grain     — fine SVG noise overlay (~0.04 opacity, overlay blend)
//                for filmic depth — no PNG ships; data: URI.
//   .vignette  — strong radial: transparent center (~38%) →
//                rgba(2,3,5,0.85) edges, to focus the eye inward.
//
// The 12-col grid from the prior treatments is intentionally DROPPED:
// a lattice over a starfield reads busy, against the minimal "deep
// field" intent.
//
// ONE infinite loop (focusBreathe) lives in AurexisAmbient.module.css —
// scoped, NOT in globals.css — so the "≤4 infinite animations in
// globals" enforcer keeps reflecting only the legacy forge backdrop.

import styles from './AurexisAmbient.module.css';

export function AurexisAmbient() {
  return (
    <div aria-hidden data-testid="aurexis-ambient" className={styles.ambient}>
      <div className={styles.starfield} />
      <div className={styles.focus} />
      <div className={styles.grain} />
      <div className={styles.vignette} />
    </div>
  );
}
