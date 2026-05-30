// SpecEarlyState — the calm, intentional early treatment for a freshly
// created project while the forge is still reading the prompt (spec
// status 'extracting'), or the rare no-spec-row edge. Replaces the old
// forge-styled bare boxes with the migrated lq aesthetic so a
// mid-classify project reads as "the forge is working", not empty.
//
// Pure presentation. The detail page is a server component that
// re-renders on router.refresh / the spec SSE 'done' event, so this
// fills into the real spec review automatically — there is NO artificial
// ticking here, and nothing fabricated: the copy only promises what the
// real pipeline will deliver.
//
// The "active" dot reuses the workshop module's single breathing rim
// (`.activeRim`) — no new infinite loop is introduced, and the global
// prefers-reduced-motion rule already freezes it to a static glow.

import { LiquidGlass } from '@/components/lq/LiquidGlass';
import styles from './workshop.module.css';

export function SpecEarlyState({
  eyebrow,
  headline,
  body,
  live = true,
}: {
  /** Mono eyebrow, e.g. "spec · detecting". */
  readonly eyebrow: string;
  /** The calm headline, e.g. "Reading your intent…". */
  readonly headline: string;
  /** One honest line about what will appear here + that it's automatic. */
  readonly body: string;
  /** Breathing dot while the forge is actively working; static for a
   *  non-progressing edge state. */
  readonly live?: boolean;
}) {
  return (
    <LiquidGlass
      as="div"
      className="flex flex-col gap-3 border-l-2 border-l-lq-aurora p-6 font-ui"
    >
      <span className="inline-flex items-center gap-2 font-code text-[10px] uppercase tracking-[0.4em] text-lq-aurora">
        <span
          aria-hidden
          className={
            'inline-block h-1.5 w-1.5 rounded-full bg-lq-aurora ' +
            (live ? styles.activeRim : '')
          }
        />
        {eyebrow}
      </span>
      <h2 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
        {headline}
      </h2>
      <p className="text-sm leading-relaxed text-lq-ink-dim">{body}</p>
    </LiquidGlass>
  );
}
