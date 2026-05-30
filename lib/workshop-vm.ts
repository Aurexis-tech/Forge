// PURE view-model for the AI-futuristic project-detail workshop. Every
// helper here is checked against the REAL system:
//   - `headerStatusVm` reads the real journey (from `deriveJourney`) and
//     the real `project.status` — no fabricated "live" pill.
//   - `pipelineDotsVm` maps each real JourneyStage to an AI palette color
//     based on its real status (done/current/blocked/failed/skipped).
//   - `phaseForCursor` derives which presentation phase the workshop is
//     in from the real cursor stage id. The phase indicator is purely
//     informational — the actual panel rendering is still gated by real
//     spec/plan/build status in the page.
//   - `headerMetaVm` formats the real created_at + real costToDateUsd
//     (from `getProjectSpend`) and OMITS tokens / latency / cache %
//     because no per-project rollup exists for those.
//
// Tested directly in node — nothing here renders, nothing fetches.

import type { Journey, JourneyStage, JourneyStageId } from '@/lib/journey';

// ---------------------------------------------------------------------------
// Color palette mapped to the AI tokens (see globals.css / tailwind.config).
// ---------------------------------------------------------------------------
export type WorkshopColor = 'mint' | 'aurora' | 'amber' | 'rose' | 'ink-dim';

// ---------------------------------------------------------------------------
// Header status pill
// ---------------------------------------------------------------------------
export interface HeaderStatusVm {
  /** Short status word for the pill — derived only from real fields. */
  readonly label: string;
  readonly color: WorkshopColor;
  /** True when the active stage should breathe (aurora pulse). */
  readonly pulse: boolean;
}

/**
 * The header status pill. Pure mapping from real journey + real project
 * status — never invents a state. Live wins; otherwise the cursor's
 * real status determines the pill.
 */
export function headerStatusVm(input: {
  journey: Journey;
  projectStatus: string;
}): HeaderStatusVm {
  const { journey, projectStatus } = input;
  if (journey.isLive) {
    return { label: 'live', color: 'mint', pulse: false };
  }
  switch (journey.cursor.status) {
    case 'failed':
      return { label: 'failed', color: 'rose', pulse: false };
    case 'blocked':
      return { label: 'gate-awaiting', color: 'amber', pulse: true };
    case 'current':
      return { label: 'forging', color: 'aurora', pulse: true };
    case 'done':
      return { label: 'settled', color: 'mint', pulse: false };
    case 'skipped':
      return { label: 'skipped', color: 'ink-dim', pulse: false };
    case 'pending':
    default:
      // Fall back to the real project.status word so we never lie.
      return { label: projectStatus || 'idle', color: 'ink-dim', pulse: false };
  }
}

// ---------------------------------------------------------------------------
// Pipeline dots — one VM per real journey stage
// ---------------------------------------------------------------------------
export interface PipelineDotVm {
  readonly id: JourneyStageId;
  readonly label: string;
  readonly index: number;
  readonly color: WorkshopColor;
  /** True ONLY on the single current stage — the aurora breathing rim. */
  readonly pulse: boolean;
  readonly status: JourneyStage['status'];
}

/**
 * Map each real journey stage to an AI palette color:
 *   - done → aurora (cooled, settled cyan)
 *   - current → amber WITH pulse (active, warming)
 *   - blocked → amber (gate awaiting)
 *   - failed → rose
 *   - skipped → ink-dim (de-emphasised)
 *   - pending → ink-dim
 */
export function pipelineDotsVm(journey: Journey): ReadonlyArray<PipelineDotVm> {
  return journey.stages.map((s) => ({
    id: s.id,
    label: s.label,
    index: s.index,
    color: colorForStatus(s.status),
    pulse: s.status === 'current',
    status: s.status,
  }));
}

function colorForStatus(status: JourneyStage['status']): WorkshopColor {
  switch (status) {
    case 'done':
      return 'aurora';
    case 'current':
      return 'amber';
    case 'blocked':
      return 'amber';
    case 'failed':
      return 'rose';
    case 'skipped':
      return 'ink-dim';
    case 'pending':
    default:
      return 'ink-dim';
  }
}

// ---------------------------------------------------------------------------
// Phase indicator — purely informational, derived from the real cursor
// ---------------------------------------------------------------------------
export type PhaseId = 'spec' | 'plan' | 'code' | 'live';

export interface PhaseVm {
  readonly id: PhaseId;
  readonly label: string;
  /** True when the cursor is inside this phase. */
  readonly active: boolean;
}

const PHASE_LABELS: Readonly<Record<PhaseId, string>> = {
  spec: 'Spec',
  plan: 'Plan',
  code: 'Code',
  live: 'Live',
};

/** Which presentation phase a given stage belongs to. Mapping is closed
 *  and exhaustive over the real `JourneyStageId` union. */
export function phaseForStage(stageId: JourneyStageId): PhaseId {
  switch (stageId) {
    case 'intent':
    case 'spec':
      return 'spec';
    case 'plan':
      return 'plan';
    case 'code':
    case 'sandbox':
    case 'provision':
    case 'preview':
    case 'confirm':
    case 'repo':
    case 'deploy':
      return 'code';
    case 'runtime':
      return 'live';
  }
}

/** The four-phase indicator VM. The cursor's stage decides which phase is
 *  marked active — no client toggle state is needed; the workshop's real
 *  position drives it. */
export function phasesVm(journey: Journey): ReadonlyArray<PhaseVm> {
  const active = phaseForStage(journey.cursor.id);
  return (['spec', 'plan', 'code', 'live'] as const).map((id) => ({
    id,
    label: PHASE_LABELS[id],
    active: id === active,
  }));
}

// ---------------------------------------------------------------------------
// Header meta — real fields only
// ---------------------------------------------------------------------------
export interface HeaderMetaVm {
  /** Project id short hash, e.g. "1f8b3c2a". */
  readonly idShort: string;
  /** Localized "created on" string for the real created_at. */
  readonly createdLabel: string;
  /** Real cost-to-date in USD as a $X.XXXX-style string (4dp matches the
   *  governance dashboard's precision). null when no spend yet. */
  readonly spendLabel: string | null;
}

export function headerMetaVm(input: {
  projectId: string;
  createdAtIso: string;
  costToDateUsd: number;
}): HeaderMetaVm {
  return {
    idShort: input.projectId.slice(0, 8),
    createdLabel: new Date(input.createdAtIso).toLocaleString(),
    spendLabel:
      input.costToDateUsd > 0
        ? '$' + input.costToDateUsd.toFixed(4)
        : null,
  };
}
