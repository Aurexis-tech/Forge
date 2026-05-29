// PURE per-mold identity for the AI-futuristic mold spaces (/agents,
// /systems, /software, /infrastructure). One immutable record per mold —
// accent, eyebrow numbering, name, tagline, description, route, empty-
// state copy, CTA label. No logic, no JSX; tested directly in node.

import type { ProjectKind } from '@/lib/types';

export type MoldAccent = 'aurora' | 'violet' | 'mint' | 'amber';

export interface MoldIdentity {
  /** The canonical mold key (matches lib/types ProjectKind). */
  readonly mold: ProjectKind;
  /** The lq accent: agents=aurora, systems=violet, software=mint, infra=amber. */
  readonly accent: MoldAccent;
  /** 1..4 — the slot in the 4-mold spine. */
  readonly ordinal: 1 | 2 | 3 | 4;
  /** "Mold · 0N / 04 · Name". */
  readonly eyebrow: string;
  /** Plural noun shown in the headline (Agents / Systems / …). */
  readonly name: string;
  /** Sublabel beside the name (e.g. "your watchers"). */
  readonly tagline: string;
  /** One-paragraph description shown under the headline. */
  readonly description: string;
  /** Route the switcher tab + browser address bar carry. */
  readonly href: string;
  /** "No agents yet." — the empty-state h2. */
  readonly emptyHeading: string;
  /** A mold-specific one-line invitation under the empty heading. */
  readonly emptyInvitation: string;
  /** "+ Forge a new agent" / "+ Forge a new system" / … */
  readonly ctaLabel: string;
}

const A: ReadonlyArray<MoldIdentity> = [
  {
    mold: 'agent',
    accent: 'aurora',
    ordinal: 1,
    eyebrow: 'Mold · 01 / 04 · Agents',
    name: 'Agents',
    tagline: 'your watchers',
    description:
      'One smart assistant per project, pursuing a single goal with tools — ' +
      'scan, summarize, schedule, notify. Built once, run forever.',
    href: '/agents',
    emptyHeading: 'No agents yet.',
    emptyInvitation:
      'Describe a watcher — what to look for, where, how often — and the forge builds it.',
    ctaLabel: '+ Forge a new agent',
  },
  {
    mold: 'system',
    accent: 'violet',
    ordinal: 2,
    eyebrow: 'Mold · 02 / 04 · Systems',
    name: 'Systems',
    tagline: 'coordinated',
    description:
      'Several agents working as one — handing off work, sharing state, ' +
      'delivering together. For jobs too big for a single agent.',
    href: '/systems',
    emptyHeading: 'No systems yet.',
    emptyInvitation:
      'Describe the team of agents you want — handoffs, schedule, what they deliver.',
    ctaLabel: '+ Forge a new system',
  },
  {
    mold: 'software',
    accent: 'mint',
    ordinal: 3,
    eyebrow: 'Mold · 03 / 04 · Software',
    name: 'Software',
    tagline: 'the apps',
    description:
      'A full application — interface, logic, data, login. The kind of thing ' +
      'people open in a browser and actually use.',
    href: '/software',
    emptyHeading: 'No software yet.',
    emptyInvitation:
      'Describe the app you want — who uses it, what they do, what they see.',
    ctaLabel: '+ Forge a new app',
  },
  {
    mold: 'infrastructure',
    accent: 'amber',
    ordinal: 4,
    eyebrow: 'Mold · 04 / 04 · Infrastructure',
    name: 'Infrastructure',
    tagline: 'the machinery',
    description:
      'The machinery underneath — vetted modules, secure by default, real ' +
      'cloud resources. Provisioned only after you say yes.',
    href: '/infrastructure',
    emptyHeading: 'No infrastructure yet.',
    emptyInvitation:
      'Describe the cloud machinery you want — and what depends on it.',
    ctaLabel: '+ Forge new infrastructure',
  },
] as const;

/** All four molds in canonical order — used by the switcher and tests. */
export const MOLD_ORDER: ReadonlyArray<ProjectKind> = A.map((m) => m.mold);

/** Lookup by mold key. */
export const MOLD_IDENTITIES: Readonly<Record<ProjectKind, MoldIdentity>> =
  Object.fromEntries(A.map((m) => [m.mold, m])) as Readonly<
    Record<ProjectKind, MoldIdentity>
  >;
