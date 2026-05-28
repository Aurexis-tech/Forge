// Pure heat-mapping helpers — the bridge between app state and the forge
// design language's heat spectrum. These are LOGIC, not primitives: the
// 5 forge components stay presentational; these functions decide WHICH
// heat tone a thing earns, so heat stays meaningful (never amber-
// everywhere) and the decision is unit-testable in isolation.

import type { HeatTone } from '@/components/forge/HeatBadge';

// EmberCard's tone union (kept local so we don't have to widen the
// primitive's API just to share the type).
export type EmberTone = 'none' | 'warm' | 'cool';

/**
 * Spend → a HeatBadge tone that visibly HEATS UP as spend approaches the
 * cap: the budget you can SEE warming. Cool with headroom, ember when
 * past halfway, glow (working heat) in the danger zone, molten at/over
 * the cap. No cap → cool (nothing to heat toward).
 *
 * Pure + deterministic — the governance dashboard reads it per period.
 */
export function spendHeatTone(
  spendUsd: number,
  limitUsd: number | null | undefined,
): HeatTone {
  if (!limitUsd || limitUsd <= 0) return 'cool';
  const pct = (spendUsd / limitUsd) * 100;
  if (pct >= 100) return 'molten'; // at / over the cap — hottest
  if (pct >= 80) return 'glow'; //   close — working-heat warning
  if (pct >= 50) return 'ember'; //  past halfway — warming
  return 'cool'; //                  plenty of headroom — settled
}

/** A short status word for the spend badge, paired with spendHeatTone. */
export function spendHeatLabel(
  spendUsd: number,
  limitUsd: number | null | undefined,
): string {
  if (!limitUsd || limitUsd <= 0) return 'no cap';
  const pct = (spendUsd / limitUsd) * 100;
  if (pct >= 100) return 'cap reached';
  return Math.round(pct) + '% of cap';
}

/**
 * A project card's EmberCard tone, "warm → cool by recency" with heat
 * discipline: a live/settled forge cools to cyan; a recently-started
 * forge still on the anvil glows warm; everything older sits quiet
 * (none) so the grid never amber-everywheres.
 *
 * Pure — pass the clock for deterministic tests.
 */
export function projectCardTone(opts: {
  isLive: boolean;
  createdAtMs: number;
  nowMs?: number;
}): EmberTone {
  if (opts.isLive) return 'cool'; // settled + serving → cooled to cyan
  const now = opts.nowMs ?? Date.now();
  const ageMs = now - opts.createdAtMs;
  const RECENT_MS = 36 * 60 * 60 * 1000; // 36h — "hot off the anvil"
  if (ageMs >= 0 && ageMs < RECENT_MS) return 'warm';
  return 'none'; // older / dormant — quiet default
}

/**
 * A connected-key card's tone + badge: warm when the key is verified and
 * in use (it's powering builds — earned heat), quiet when missing.
 */
export function keyStatusTone(connected: boolean): {
  card: EmberTone;
  badge: HeatTone;
} {
  return connected
    ? { card: 'warm', badge: 'glow' } // verified + in use → warm
    : { card: 'none', badge: 'dim' }; // missing → quiet
}
