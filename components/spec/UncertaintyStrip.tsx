// "Needs your attention" strip — renders the per-mold uncertainty
// entries above the main spec body in the show-spec gate.
//
// Backward-compatible by design: when `confidence` is null/undefined
// (historical specs) or the buildUncertaintyStripItems helper
// returns an empty array, this component renders NOTHING. No empty
// panel clutters the gate.
//
// Order (per the brief):
//
//   1. 'missing' fields — rose tone, HIGHEST attention.
//   2. 'guessed' fields — amber tone, "engine picked a default."
//   3. 'inferred' fields — cyan tone, only those above the engine's
//      LEVERAGE_THRESHOLD (low-leverage inferred entries are noise).
//
// Brand tokens: forge-amber + forge-cyan + plain Tailwind rose. 2D,
// WebGL-off friendly.

import { ConfidenceBadge } from './ConfidenceBadge';
import {
  buildUncertaintyStripItems,
  humaniseFieldName,
  type SpecConfidence,
} from './confidence-display';
import type { SpecMold } from '@/lib/engine/spec/quality';

export interface UncertaintyStripProps {
  mold: SpecMold;
  confidence: SpecConfidence | null | undefined;
}

export function UncertaintyStrip({ mold, confidence }: UncertaintyStripProps) {
  const items = buildUncertaintyStripItems(mold, confidence);
  if (items.length === 0) return null;

  // Counts per level — surfaced in the header so the user sees the
  // shape at a glance ("3 missing, 1 guessed").
  const counts = {
    missing: items.filter((i) => i.level === 'missing').length,
    guessed: items.filter((i) => i.level === 'guessed').length,
    inferred: items.filter((i) => i.level === 'inferred').length,
  };
  const summaryBits: string[] = [];
  if (counts.missing > 0)
    summaryBits.push(counts.missing + ' missing');
  if (counts.guessed > 0)
    summaryBits.push(counts.guessed + ' guessed');
  if (counts.inferred > 0)
    summaryBits.push(counts.inferred + ' inferred');

  return (
    <section
      data-testid="uncertainty-strip"
      className="rounded-xl border border-rose-400/30 bg-rose-500/[0.04] p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-200">
          needs your attention
        </h3>
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {summaryBits.join(' · ')}
        </p>
      </header>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.field + ':' + item.level}
            data-field={item.field}
            data-level={item.level}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 bg-black/30 px-3 py-2"
          >
            <ConfidenceBadge level={item.level} />
            <span className="font-mono text-xs text-forge-text">
              {humaniseFieldName(item.field)}
            </span>
            <span className="text-xs text-forge-dim">{item.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
