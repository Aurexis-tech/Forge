// PURE config + zone math for the AI-futuristic Governance page. Everything
// here is checked against the REAL system:
//   - `spendZone` REUSES `spendHeatTone`'s thresholds (cool/ember/glow/molten)
//     and remaps the four tones to the AI palette (mint/aurora/amber/rose).
//     The zone math is NOT forked — adding a new threshold here would require
//     adding it in `spendHeatTone` too.
//   - `KILL_SWITCH_COPY` describes the REAL action the engage button takes
//     (POST /api/governance/killswitch { scope:'global' } → halts the
//     scheduler + refuses new cost-incurring actions until cleared).
//   - `runtimeStatusVm` maps a real `AgentRuntime.status` to an aurora/dim
//     accent — no invented states.
//   - `costEventTone` colors a real ledger event by its real `kind`.
//
// Tested directly in node — nothing here renders, nothing fetches.

import { spendHeatTone } from '@/lib/forge-heat';
import type { RuntimeStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Spend zones — REUSE spendHeatTone's thresholds, remap to AI colors.
// ---------------------------------------------------------------------------

export type SpendZone = 'no-cap' | 'safe' | 'steady' | 'warming' | 'over';
export type SpendColor = 'mint' | 'aurora' | 'amber' | 'rose';

export interface SpendZoneVm {
  readonly zone: SpendZone;
  /** Short uppercase status word for the badge. */
  readonly label: string;
  /** Which AI palette color carries this zone. */
  readonly color: SpendColor;
  /** Plain-language headroom line for the meter sub-row. */
  readonly headroom: string;
}

/**
 * Real spend × real cap → a typed zone view-model. NO CAP is its own zone
 * (so the meter doesn't lie by sitting at "0% UNDER CAP").
 *
 * Thresholds come from `spendHeatTone` — this function only remaps the
 * four tones to AI colors + copy. Add a band there if you need one here.
 */
export function spendZone(
  spentUsd: number,
  capUsd: number | null | undefined,
): SpendZoneVm {
  if (capUsd == null || capUsd <= 0) {
    return {
      zone: 'no-cap',
      label: 'NO CAP SET',
      color: 'mint',
      headroom: 'No cap set — every dollar is allowed through.',
    };
  }
  const tone = spendHeatTone(spentUsd, capUsd);
  const pct = (spentUsd / capUsd) * 100;
  const remaining = Math.max(0, capUsd - spentUsd);
  switch (tone) {
    case 'cool':
      return {
        zone: 'safe',
        label: 'UNDER CAP',
        color: 'mint',
        headroom: '$' + remaining.toFixed(2) + ' headroom · ' +
          pct.toFixed(0) + '% of cap',
      };
    case 'ember':
      return {
        zone: 'steady',
        label: 'STEADY',
        color: 'aurora',
        headroom: '$' + remaining.toFixed(2) + ' headroom · ' +
          pct.toFixed(0) + '% of cap',
      };
    case 'glow':
      return {
        zone: 'warming',
        label: 'WARMING',
        color: 'amber',
        headroom: '$' + remaining.toFixed(2) + ' headroom · ' +
          pct.toFixed(0) + '% of cap — close to the cap',
      };
    case 'molten':
      return {
        zone: 'over',
        label: 'AT CAP',
        color: 'rose',
        headroom: 'Cap reached — new actions are blocked',
      };
    default:
      // `spendHeatTone` only ever returns the four tones above for the
      // spend domain; the broader HeatTone union (HeatBadge's tones) is
      // what the type system shows here. This branch is unreachable at
      // runtime — kept so the function is statically exhaustive.
      return {
        zone: 'safe',
        label: 'UNDER CAP',
        color: 'mint',
        headroom: pct.toFixed(0) + '% of cap',
      };
  }
}

/** Filled fraction (0..1) for the meter bar — bounded to [0,1] so the
 *  bar never overflows even when spend is over the cap. */
export function meterFill(
  spentUsd: number,
  capUsd: number | null | undefined,
): number {
  if (capUsd == null || capUsd <= 0) return 0;
  const f = spentUsd / capUsd;
  if (!Number.isFinite(f) || f <= 0) return 0;
  if (f > 1) return 1;
  return f;
}

// ---------------------------------------------------------------------------
// Kill switch copy — single source for the prose, so the button never makes
// a claim the real action doesn't honor.
// ---------------------------------------------------------------------------

export interface KillSwitchCopy {
  readonly eyebrow: string;
  readonly headline: string;
  /** What engaging the lever actually does on the server. */
  readonly engagedMechanism: string;
  /** What the lever does when it's currently engaged. */
  readonly engagedNow: string;
  /** Button labels — paired so the page reads from one source. */
  readonly engageCta: string;
  readonly clearCta: string;
  /** Native-confirm prompts (real, not bypassable). */
  readonly engageConfirm: string;
  readonly clearConfirm: string;
}

export const KILL_SWITCH_COPY: KillSwitchCopy = {
  eyebrow: 'KILL SWITCH · GLOBAL',
  headline: 'One lever. Everything stops.',
  engagedMechanism:
    'Engaging halts the scheduler and refuses every new cost-incurring ' +
    'action with a clear message. Clearing resumes — active runtimes do ' +
    'not need re-activation.',
  engagedNow:
    'System paused. All cron ticks and new cost-incurring actions are ' +
    'blocked until you clear it.',
  engageCta: 'Pull lever',
  clearCta: 'Release lever',
  engageConfirm:
    'Engage the global kill switch? All ticks and new cost-incurring ' +
    'actions will be blocked until you clear it.',
  clearConfirm:
    'Clear the global kill switch and resume cost-incurring actions?',
};

// ---------------------------------------------------------------------------
// Runtime status view-model — REAL statuses only (RuntimeStatus union).
// ---------------------------------------------------------------------------

export interface RuntimeStatusVm {
  readonly label: string;
  readonly color: SpendColor | 'ink-dim';
  readonly live: boolean;
}

export function runtimeStatusVm(status: RuntimeStatus | string): RuntimeStatusVm {
  switch (status) {
    case 'active':
      return { label: 'active', color: 'aurora', live: true };
    case 'paused':
      return { label: 'paused', color: 'ink-dim', live: false };
    case 'errored':
      return { label: 'errored', color: 'rose', live: false };
    case 'stopped':
      return { label: 'stopped', color: 'ink-dim', live: false };
    default:
      return { label: String(status), color: 'ink-dim', live: false };
  }
}

// ---------------------------------------------------------------------------
// Cost event tone — one AI color per real ledger kind.
// ---------------------------------------------------------------------------

export function costEventTone(kind: string): SpendColor | 'ink-dim' {
  switch (kind) {
    case 'llm':
      return 'amber';
    case 'sandbox':
      return 'aurora';
    case 'runtime':
      return 'mint';
    default:
      return 'ink-dim';
  }
}

// ---------------------------------------------------------------------------
// Audit actor tone — same actors the engine actually writes to audit_log.
// ---------------------------------------------------------------------------

export function auditActorTone(actor: string): SpendColor | 'ink-dim' {
  if (actor === 'user') return 'amber';
  if (actor === 'engine.governance') return 'rose';
  if (actor.startsWith('engine.')) return 'aurora';
  if (actor.startsWith('integration.')) return 'mint';
  return 'ink-dim';
}
