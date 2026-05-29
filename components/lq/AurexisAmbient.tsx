// AurexisAmbient — the AI-futuristic global backdrop (void + 12-col grid +
// aurora/violet breathing glows + vignette). DORMANT: this is built and
// tested in isolation but is NOT mounted anywhere yet. ForgeBackdrop
// remains the live backdrop; the Landing prompt mounts this so the
// backdrop and the first migrated page flip together.
//
// Pure presentation (no hooks) — like ForgeBackdrop, a server component.
// Its two infinite breathe loops live in AurexisAmbient.module.css, scoped
// so they only count against the live animation budget once mounted.

import styles from './AurexisAmbient.module.css';

export function AurexisAmbient() {
  return (
    <div aria-hidden data-testid="aurexis-ambient" className={styles.ambient}>
      <div className={styles.grid} />
      <div className={styles.aurora} />
      <div className={styles.violet} />
      <div className={styles.vignette} />
    </div>
  );
}
