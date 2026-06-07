// PURE data + sequence for the Landing live-demo panel. No React, no DOM,
// no timers here — just the script the <LiveDemo> client component plays
// with a JS state machine. Extracted so the sequence (stage order, the
// gate, the terminal stage, timings, the typed intent) is unit-testable
// in the repo's node-only test env (like specularOffset / the molds data).

/** The intent line that types itself, char-by-char, at the top of the demo. */
export const DEMO_INTENT =
  'Scan new arXiv CV papers daily and email me a 5-bullet brief at 07:00.';

/** The mold the demo "detects" after the intent is typed. */
export const DEMO_MOLD = 'AGENT';

/** Per-char typing cadence + the detection beats (ms). */
export const DEMO_TYPE_MS = 28;
export const DEMO_DETECT_PULSE_MS = 600; // "detecting mold" pulses
export const DEMO_DETECT_SNAP_MS = 700; // → "AGENT · detected"
/** How long the finished pipeline holds on Live before the loop resets. */
export const DEMO_LIVE_HOLD_MS = 3500;

export type DemoTone = 'aurora' | 'mint' | 'amber';

export interface DemoStage {
  /** Stable id (also the pipeline-dot key). */
  id: string;
  /** Short pipeline-dot label. */
  label: string;
  /** Dwell time once this stage activates (ms). Intent is 0 — it's the
   *  typed line, paced by typing, not a pipeline dwell. */
  durationMs: number;
  /** The stage card text shown mid-panel while this stage is active
   *  (null for Intent — its "card" is the typed intent line). */
  card: string | null;
  /** Accent for this stage's card + dot. */
  tone: DemoTone;
  /** Code stage streams a filename with a blinking cursor. */
  streaming?: boolean;
  /** Repo is the human-decision GATE (amber dot). */
  gate?: boolean;
  /** Live is the terminal stage (mint dot). */
  terminal?: boolean;
}

// The canonical 8-dot pipeline: Intent · Spec · Plan · Code · Sandbox ·
// Repo · Deploy · Live. Timings (ms) for Spec→Live per the spec; Intent
// is paced by the typing animation.
export const DEMO_STAGES: ReadonlyArray<DemoStage> = [
  { id: 'intent', label: 'Intent', durationMs: 0, card: null, tone: 'aurora' },
  {
    id: 'spec',
    label: 'Spec',
    durationMs: 1200,
    card: 'Spec generated · kind: agent · tools: web_search · summarize · send_email',
    tone: 'aurora',
  },
  {
    id: 'plan',
    label: 'Plan',
    durationMs: 1300,
    card: 'Plan · 4 steps · scaffold → wire tools → codegen → schedule',
    tone: 'aurora',
  },
  {
    id: 'code',
    label: 'Code',
    durationMs: 2200,
    card: 'Streaming · src/tools/web_search.ts',
    tone: 'aurora',
    streaming: true,
  },
  {
    id: 'sandbox',
    label: 'Sandbox',
    durationMs: 1700,
    card: 'Sandbox passed · microVM · capabilities verified · RLS ok',
    tone: 'mint',
  },
  {
    id: 'repo',
    label: 'Repo',
    durationMs: 2200,
    card: 'Repo gate · auto-approved (demo) · private repo · 1 commit',
    tone: 'amber',
    gate: true,
  },
  {
    id: 'deploy',
    label: 'Deploy',
    durationMs: 1800,
    card: 'Deploying to Vercel · cron 0 7 * * * · ~14s',
    tone: 'aurora',
  },
  {
    id: 'live',
    label: 'Live',
    durationMs: 2200,
    card: 'Live · next run tomorrow 07:00 UTC · $0.04/run',
    tone: 'mint',
    terminal: true,
  },
];

/** The index of the terminal (Live) stage — the static reduced-motion
 *  state and the "hold then loop" both key off this. */
export const DEMO_LIVE_INDEX = DEMO_STAGES.length - 1;

// ---------------------------------------------------------------------------
// Mold showcase — the public front-door gallery. NOT a personal library
// count (which would be fictional on a fresh account): each card shows a
// representative example + illustrative stats + a link into that mold space.
// ---------------------------------------------------------------------------

export type MoldAccent = 'aurora' | 'blue' | 'violet' | 'magenta';

export interface MoldShowcaseCard {
  mold: string;
  accent: MoldAccent;
  href: string;
  name: string; // the lower-key short title
  example: string; // the example identifier
  what: string; // one-line "what it is"
  stats: [string, string, string];
}

export const MOLD_SHOWCASE: ReadonlyArray<MoldShowcaseCard> = [
  {
    mold: 'Agents',
    accent: 'aurora',
    href: '/agents',
    name: 'Agents',
    example: 'arxiv-morning-brief',
    what: 'Scans new CV papers daily, emails a 5-bullet brief at 07:00 UTC.',
    stats: ['$0.04 per run', '0.7s p95', '100% uptime'],
  },
  {
    mold: 'Systems',
    accent: 'blue',
    href: '/systems',
    name: 'Systems',
    example: 'competitor-watch',
    what: 'Three agents tracking five competitors weekly — pricing, hiring, social — into a Monday digest.',
    stats: ['$0.84 weekly', '3 agents', '98% uptime'],
  },
  {
    mold: 'Software',
    accent: 'violet',
    href: '/software',
    name: 'Software',
    example: 'expense-flow',
    what: 'Employees submit, managers approve, everyone sees status.',
    stats: ['23 users', '$2.40 monthly', '0 errors'],
  },
  {
    mold: 'Infrastructure',
    accent: 'magenta',
    href: '/infrastructure',
    name: 'Infrastructure',
    example: 'team-postgres',
    what: 'Postgres with row-level security for a four-person team, daily backups, observability.',
    stats: ['4 members', '$12.40 monthly', '7d backups'],
  },
];

/** The final, settled demo state — what reduced-motion renders statically
 *  (all dots done, Live active + mint, the Live card shown). */
export function demoFinalState() {
  return {
    typed: DEMO_INTENT,
    moldDetected: true,
    activeIndex: DEMO_LIVE_INDEX,
    card: DEMO_STAGES[DEMO_LIVE_INDEX]!.card,
    done: true,
  } as const;
}
