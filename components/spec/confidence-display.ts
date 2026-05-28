// Pure presentation helpers for the show-spec gate's confidence
// rendering. Everything in this file is a deterministic function —
// no React, no DOM, no I/O — so the four *SpecView + *ReviewPanel
// components can share one tested source of truth + render tests
// run in node without happy-dom.
//
// THIS FILE IS THE VISUAL CONTRACT for the four confidence levels:
//
//   - 'stated'   → low visual weight, ✓ "from you". The user said it.
//   - 'inferred' → cyan tone, "inferred". Mid weight.
//   - 'guessed'  → amber tone, "guessed default". Higher weight; the
//                  user should glance at it.
//   - 'missing'  → rose tone, "missing — please specify". HIGHEST
//                  weight; eye goes here first.
//
// Tones use existing brand tokens (forge-amber, forge-cyan) + plain
// Tailwind rose (no `forge-rose` token exists yet — and the brief
// doesn't ask us to add one; the stock rose-* family is brand-
// compatible at this saturation).

import {
  detectUncertainty,
  type UncertaintyEntry,
} from '@/lib/engine/spec/uncertainty';
import type { SpecMold } from '@/lib/engine/spec/quality';
import {
  type ConfidenceLevel,
  type SpecConfidence,
} from '@/lib/engine/spec/confidence';

// ---------------------------------------------------------------------------
// Per-level visual config — single source of truth.
// ---------------------------------------------------------------------------

export const CONFIDENCE_PRESENTATION: Record<
  ConfidenceLevel,
  {
    /** Short label shown in the badge. */
    readonly label: string;
    /** One-line note shown in the uncertainty strip for this level. */
    readonly stripNote: string;
    /** Glyph that appears before the label in the badge. */
    readonly glyph: string;
    /** Tailwind class string — border + text + bg combined. */
    readonly toneClass: string;
    /** Visual-weight rank used to ORDER the uncertainty strip. Higher = more eye-attention. */
    readonly weight: number;
  }
> = {
  // LOW weight — the user already knows what they said.
  stated: {
    label: 'from you',
    stripNote: '',
    glyph: '✓',
    toneClass: 'border-white/10 text-forge-dim bg-transparent',
    weight: 0,
  },
  // MID weight — cyan, the same tone the rest of the UI uses for
  // engine-derived information (think labels on Section headers).
  inferred: {
    label: 'inferred',
    stripNote: 'inferred from context — confirm or correct.',
    glyph: '•',
    toneClass: 'border-forge-cyan/30 text-forge-cyan bg-forge-cyan/[0.06]',
    weight: 1,
  },
  // HIGHER weight — amber. Matches the existing amber "review · awaiting
  // confirm" header in the gate, so the eye picks it up.
  guessed: {
    label: 'guessed default',
    stripNote: 'engine picked a default — accept it or change it.',
    glyph: '!',
    toneClass: 'border-forge-amber/40 text-forge-amber bg-forge-amber/[0.08]',
    weight: 2,
  },
  // HIGHEST weight — rose. The brief calls this out explicitly:
  // missing fields surface first; the user should fix these before
  // confirming.
  missing: {
    label: 'missing — please specify',
    stripNote: 'left out — please add this before confirming.',
    glyph: '?',
    toneClass: 'border-rose-400/50 text-rose-300 bg-rose-500/[0.08]',
    weight: 3,
  },
};

// ---------------------------------------------------------------------------
// Strip item shape.
// ---------------------------------------------------------------------------
export interface UncertaintyStripItem {
  readonly field: string;
  readonly level: ConfidenceLevel;
  readonly note: string;
  readonly weight: number;
  readonly leverage: number;
}

/**
 * Build the ordered list of items to render in the "needs your
 * attention" strip. ORDER:
 *
 *   1. All 'missing' fields, by leverage DESC then field-name ASC.
 *   2. All 'guessed' fields, by leverage DESC then field-name ASC.
 *   3. All 'inferred' fields whose leverage is above the engine's
 *      LEVERAGE_THRESHOLD (low-leverage inferred entries are noise
 *      and don't appear in the strip).
 *
 * Returns an empty array when there are no uncertainties — the UI
 * renders NOTHING in that case (no empty panel).
 *
 * Pure function — no DB, no LLM. Reuses the engine's
 * `detectUncertainty` to get leverage + ordering, then re-buckets
 * by level since the strip wants per-level grouping rather than
 * pure leverage order.
 */
export function buildUncertaintyStripItems(
  mold: SpecMold,
  confidence: SpecConfidence | null | undefined,
): UncertaintyStripItem[] {
  if (!confidence || Object.keys(confidence).length === 0) return [];
  // The detector returns entries sorted by leverage DESC + stable
  // tie-breaks. We re-bucket by level so missing surfaces first
  // even when a guessed entry has higher leverage.
  const report = detectUncertainty({
    mold,
    spec: {},
    confidence,
    intent: '',
  });
  // Buckets keyed by level — preserve detector ordering inside each.
  const missing: UncertaintyEntry[] = [];
  const guessed: UncertaintyEntry[] = [];
  const inferred: UncertaintyEntry[] = [];
  for (const entry of report.entries) {
    if (entry.level === 'missing') missing.push(entry);
    else if (entry.level === 'guessed') guessed.push(entry);
    else if (entry.level === 'inferred') inferred.push(entry);
  }
  const items: UncertaintyStripItem[] = [];
  for (const entry of [...missing, ...guessed, ...inferred]) {
    items.push({
      field: entry.field,
      level: entry.level,
      note: CONFIDENCE_PRESENTATION[entry.level].stripNote,
      weight: CONFIDENCE_PRESENTATION[entry.level].weight,
      leverage: entry.leverage,
    });
  }
  return items;
}

/**
 * Convenience: did the confidence map produce any uncertainties
 * worth showing in the strip? When false, the strip component
 * renders nothing.
 */
export function hasUncertainties(
  mold: SpecMold,
  confidence: SpecConfidence | null | undefined,
): boolean {
  return buildUncertaintyStripItems(mold, confidence).length > 0;
}

/**
 * Render-friendly: pick the level for a single field, gracefully
 * handling the case where confidence is undefined (historical specs)
 * OR the field isn't in the map (a field the per-mold confidence
 * compute didn't classify, by design — those have no badge).
 */
export function levelForField(
  confidence: SpecConfidence | null | undefined,
  field: string,
): ConfidenceLevel | null {
  if (!confidence) return null;
  const v = confidence[field];
  if (!v) return null;
  return v;
}

/**
 * Convert a field name like 'auth_per_user_isolation' into a human
 * label like 'Auth: per user isolation'. Mechanical; the field
 * naming convention is lower_snake_case so this is just a
 * substitution.
 */
export function humaniseFieldName(field: string): string {
  // Split common compound prefixes for readability.
  const withSpaces = field.replace(/_/g, ' ');
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

// Re-export the engine's level type so consumers don't need a
// separate import.
export type { ConfidenceLevel, SpecConfidence };
