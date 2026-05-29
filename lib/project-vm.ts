// PURE project → view-model mapping for ProjectCardAi. All deriving lives
// here so the card stays a thin renderer and the mapping is unit-testable
// node-side (no DOM, no React). Honest about the data we have: stage +
// cursor + mold are real; runs/cost/uptime/spend/cache aren't plumbed to
// the card yet, so they render as "—".
//
// The "status" field is the project's headline state — what the status
// pill and pipeline-tone derive from. Order: detecting > paused > live >
// gate > forging.

import type { Journey, JourneyStage } from '@/lib/journey';
import type { ProjectMold } from '@/lib/molds';
import type { ProjectCardData } from '@/lib/project-cards';

export type ProjectVmStatus =
  | 'detecting'
  | 'live'
  | 'paused'
  | 'gate'
  | 'forging';

export type ProjectAccent = 'aurora' | 'violet' | 'mint' | 'amber';

export type ProjectDotTone =
  | 'aurora'
  | 'aurora-soft'
  | 'mint'
  | 'amber'
  | 'rose'
  | 'ghost';

export interface ProjectStat {
  readonly label: string;
  readonly value: string;
}

export interface ProjectDot {
  readonly tone: ProjectDotTone;
  readonly pulse: boolean;
}

export interface ProjectVm {
  readonly status: ProjectVmStatus;
  readonly moldAccent: ProjectAccent | null;
  readonly moldLabel: string;
  readonly name: string;
  readonly subline: string;
  readonly stats: ReadonlyArray<ProjectStat>;
  readonly dots: ReadonlyArray<ProjectDot>;
}

const MOLD_ACCENT: Record<Exclude<ProjectMold, 'unclassified'>, ProjectAccent> = {
  agent: 'aurora',
  system: 'violet',
  software: 'mint',
  infrastructure: 'amber',
};

const MOLD_LABEL: Record<ProjectMold, string> = {
  agent: 'Agent',
  system: 'System',
  software: 'Software',
  infrastructure: 'Infrastructure',
  unclassified: 'Detecting…',
};

/** Stages where "awaiting…" in the cursor reads as a human-decision GATE. */
const GATE_STAGE_IDS = new Set(['repo', 'deploy', 'confirm']);
const GATE_DETAIL_RE = /awaiting|authoris|approve|review|confirm/i;
const PAUSED_DETAIL_RE = /paused|offline/i;

const DASH = '—';

/** Pure: derive the headline status from journey + mold + project.status. */
export function deriveStatus(card: {
  journey: Journey;
  mold: ProjectMold;
  project: { status: string };
}): ProjectVmStatus {
  if (card.mold === 'unclassified') return 'detecting';
  const cursor = card.journey.cursor;

  const isPaused =
    card.project.status === 'paused' ||
    (card.journey.isLive && PAUSED_DETAIL_RE.test(cursor.detail));
  if (isPaused) return 'paused';

  if (card.journey.isLive) return 'live';

  if (cursor.status === 'current' && GATE_DETAIL_RE.test(cursor.detail)) {
    return 'gate';
  }

  return 'forging';
}

function relativeTime(createdAt: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - new Date(createdAt).getTime());
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  const mo = Math.floor(d / 30);
  return mo + 'mo ago';
}

function statsFor(status: ProjectVmStatus, age: string): ReadonlyArray<ProjectStat> {
  switch (status) {
    case 'live':
      return [
        { label: 'runs', value: DASH },
        { label: 'cost', value: DASH },
        { label: 'uptime', value: DASH },
      ];
    case 'forging':
      return [
        { label: 'age', value: age },
        { label: 'spend', value: DASH },
        { label: 'cache', value: DASH },
      ];
    case 'gate':
      return [
        { label: 'action', value: 'approve →' },
        { label: 'spend', value: DASH },
        { label: DASH, value: DASH },
      ];
    case 'paused':
      return [
        { label: 'status', value: 'paused' },
        { label: DASH, value: DASH },
        { label: DASH, value: DASH },
      ];
    case 'detecting':
      return [
        { label: DASH, value: DASH },
        { label: DASH, value: DASH },
        { label: DASH, value: DASH },
      ];
  }
}

function dotFor(
  stage: JourneyStage,
  i: number,
  isLast: boolean,
  journey: Journey,
  status: ProjectVmStatus,
): ProjectDot {
  // Paused: the last (Live) dot dims at reduced opacity, no pulse.
  if (status === 'paused' && isLast) return { tone: 'aurora-soft', pulse: false };
  // Live terminal: mint pulse on the last dot.
  if (isLast && journey.isLive) return { tone: 'mint', pulse: true };

  switch (stage.status) {
    case 'done':
      return { tone: 'aurora-soft', pulse: false };
    case 'current': {
      if (status === 'gate' && GATE_STAGE_IDS.has(stage.id)) {
        return { tone: 'amber', pulse: true };
      }
      if (status === 'live') return { tone: 'mint', pulse: true };
      return { tone: 'aurora', pulse: true };
    }
    case 'failed':
      return { tone: 'rose', pulse: false };
    case 'pending':
    case 'skipped':
    case 'blocked':
    default:
      return { tone: 'ghost', pulse: false };
  }
}

export function projectVm(
  card: ProjectCardData,
  opts?: { nowMs?: number },
): ProjectVm {
  const nowMs = opts?.nowMs ?? Date.now();
  const status = deriveStatus(card);
  const moldAccent =
    card.mold === 'unclassified' ? null : MOLD_ACCENT[card.mold];
  const moldLabel = MOLD_LABEL[card.mold];
  const name = card.project.name;
  const cursor = card.journey.cursor;
  const subline =
    'Stage ' +
    String(cursor.index).padStart(2, '0') +
    ' · ' +
    cursor.label +
    (cursor.detail ? ' · ' + cursor.detail : '');
  const stats = statsFor(status, relativeTime(card.project.created_at, nowMs));
  const lastIndex = card.journey.stages.length - 1;
  const dots = card.journey.stages.map((s, i) =>
    dotFor(s, i, i === lastIndex, card.journey, status),
  );
  return { status, moldAccent, moldLabel, name, subline, stats, dots };
}
