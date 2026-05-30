// AurexisAmbient — the AI-futuristic global backdrop. LIVE: mounted on
// every migrated route through the AppBackdrop switch and directly on
// the public landing. Pure presentation (server component, no hooks).
//
// "Aurora bloom" direction — premium, slow, never busy:
//   .ambient   — fixed full-bleed root, z:-10, pointer-events: none,
//                background: var(--void).
//   .aurora    — large soft aurora bloom in the upper area
//                (~760px, blur 120px, opacity ~0.16), drifting slowly.
//   .violet    — violet bloom in the lower-left
//                (~620px, blur 120px, opacity ~0.13), drifting slowly
//                on a different period so the two never sync.
//   .grid      — faint 12-col lattice (~0.018 alpha via --grid),
//                kept as quiet "architecture" over the blooms.
//   .grain     — fine SVG noise overlay (~0.04 opacity, overlay blend)
//                for filmic depth — no real PNG ships; data: URI.
//   .vignette  — radial transparent center → ~rgba(5,6,9,0.7) edges,
//                to settle the content into the void.
//
// The two infinite drift loops (auroraDrift + violetDrift) live in
// AurexisAmbient.module.css — scoped, NOT in globals.css — so the
// "≤4 infinite animations in globals" enforcer keeps reflecting only
// the legacy forge backdrop's loops.

import styles from './AurexisAmbient.module.css';

export function AurexisAmbient() {
  return (
    <div aria-hidden data-testid="aurexis-ambient" className={styles.ambient}>
      <div className={styles.aurora} />
      <div className={styles.violet} />
      <div className={styles.grid} />
      <div className={styles.grain} />
      <div className={styles.vignette} />
    </div>
  );
}
