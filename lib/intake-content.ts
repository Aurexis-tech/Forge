// Intake (new-forge) copy + starter examples — mold-agnostic.
//
// The Forge has ONE unified intake: you describe what you want in plain
// language and the engine AUTO-DETECTS the mold (agent · system · software
// · infrastructure). There is no mold picker and nothing here pre-sets a
// mold — the `mold` tag on each example is DISPLAY-ONLY (it labels the
// chip + lets users see the range); only `prompt` is ever used (it fills
// the describe box verbatim) and the request body carries only the raw
// prompt.
//
// Kept pure + client-safe (types only) so the copy + starters are
// unit-testable without a DOM — the IntakeForm component is a thin
// wrapper over this data.

import type { ProjectKind } from '@/lib/types';

export const INTAKE_COPY = {
  eyebrow: 'welcome · stage 01',
  heading: 'Describe what you want to build',
  // Keeps the original spec→…→live-URL promise, then names the full range
  // + the auto-detection so the intake reads for all four molds.
  subcopy:
    "Plain language. Be specific about what it does and who it's for — the " +
    'Forge turns it into a structured spec, plan, code, tested sandbox, repo, ' +
    'and (when you approve) a live URL. It builds an agent, a multi-agent ' +
    'system, a full app, or infrastructure — and detects which from your ' +
    'description.',
  placeholder:
    'e.g. A research assistant that scans new arXiv papers each morning and ' +
    'emails me a 5-bullet brief.',
  ariaLabel: 'Project description',
  emptyError: 'Describe what you want to build first.',
  // Generic pipeline line — the same INTENT→…→LIVE spine every mold shares
  // at a glance. Unchanged by this copy pass.
  pipeline: 'intent → spec → plan → code → sandbox → repo → deploy → live',
} as const;

export interface IntakeExample {
  /**
   * The mold this example illustrates. DISPLAY-ONLY — used for the chip
   * label and to show the range. It is NOT sent to the API and does NOT
   * pre-set a mold; the engine auto-detects from the prompt.
   */
  readonly mold: ProjectKind;
  readonly title: string;
  /** Fills the describe box verbatim when the chip is clicked. */
  readonly prompt: string;
}

// One starter per mold so a newcomer sees the full range at a glance.
// Clicking any chip simply fills the describe box with `prompt`; the
// engine then auto-detects the mold exactly as if the user had typed it.
export const INTAKE_EXAMPLES: readonly IntakeExample[] = [
  {
    mold: 'agent',
    title: 'Agent',
    prompt:
      'A research assistant that scans new arXiv papers each morning and ' +
      'emails me a 5-bullet brief.',
  },
  {
    mold: 'system',
    title: 'System',
    prompt:
      'A system that watches three competitors — one agent gathers news, ' +
      'one summarizes each source, one writes me a Monday briefing.',
  },
  {
    mold: 'software',
    title: 'Software',
    prompt:
      'A web app where my team submits expenses, a manager approves them, ' +
      'and everyone sees their own history.',
  },
  {
    mold: 'infrastructure',
    title: 'Infrastructure',
    prompt:
      'A pipeline that ingests events from my sources every hour, stores ' +
      'them, and serves them to my other tools.',
  },
];
