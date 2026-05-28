// Per-field confidence badge — a tiny pill the four *SpecView
// components render next to each top-level field's label.
//
// Backward-compatible by design: when `level` is null/undefined
// (historical specs without a confidence_json column, or a field
// the per-mold compute didn't classify), the component renders
// NOTHING. The four SpecView files can drop this in unconditionally
// without an `if (level) ...` guard.
//
// Brand tokens: forge-amber + forge-cyan + plain Tailwind rose for
// 'missing'. WebGL-off friendly — pure 2D markup, no Three.

import {
  CONFIDENCE_PRESENTATION,
  type ConfidenceLevel,
} from './confidence-display';

export interface ConfidenceBadgeProps {
  /**
   * The confidence level for the parent field. `null` / `undefined`
   * means "no confidence info" — the badge renders nothing.
   */
  level: ConfidenceLevel | null | undefined;
  /** Optional override for the badge label. Defaults to the canonical level label. */
  label?: string;
  /** Compact mode strips the glyph + label, leaving just the tone. Used by inline KV badges. */
  compact?: boolean;
}

export function ConfidenceBadge({
  level,
  label,
  compact = false,
}: ConfidenceBadgeProps) {
  if (!level) return null;
  const cfg = CONFIDENCE_PRESENTATION[level];
  const text = label ?? cfg.label;
  return (
    <span
      data-confidence-level={level}
      className={
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] ' +
        cfg.toneClass
      }
      title={text}
    >
      <span aria-hidden="true">{cfg.glyph}</span>
      {compact ? null : <span>{text}</span>}
    </span>
  );
}
