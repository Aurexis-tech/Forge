// The four molds as the app's organizing spine.
//
// THE single source of truth for "which mold space does a project belong
// to, and how is each mold presented?". The four molds reuse the engine's
// canonical `ProjectKind` enum (lib/types.ts) — the discriminator the
// classifier persists on `projects.kind`. We add ONE IA-level state on
// top: `'unclassified'` — a brand-new forge whose type the engine hasn't
// detected yet ("Detecting…"). It is NOT a mold; it never gets its own
// space — it lives in Home until classification assigns a real mold.
//
// CLIENT-SAFE: imports only types. No engine / server code, so client
// components (MoldBadge, AppNav, ProjectCard) can import it freely.

import type { Project, ProjectKind, Spec } from '@/lib/types';

// The four molds, in display order. `satisfies` ties this to the canonical
// ProjectKind union — a stray value here fails the typecheck, so this list
// can never drift from the engine enum.
export const PROJECT_MOLDS = [
  'agent',
  'system',
  'software',
  'infrastructure',
] as const satisfies readonly ProjectKind[];

// A project's mold for IA grouping: one of the four real molds, or the
// explicit "not yet classified" state.
export type ProjectMold = ProjectKind | 'unclassified';

function isProjectKind(value: unknown): value is ProjectKind {
  return (
    value === 'agent' ||
    value === 'system' ||
    value === 'software' ||
    value === 'infrastructure'
  );
}

/**
 * The mold a project belongs to for IA grouping.
 *
 * A project is only "classified" once spec extraction has begun — which
 * is exactly when the classifier writes `projects.kind`. Before that the
 * `kind` column is just its DB default ('agent'), NOT a real detection,
 * so we return 'unclassified' and never guess a mold. A stray / unknown
 * stored kind also resolves to 'unclassified' rather than being
 * mislabeled.
 */
export function resolveProjectMold(
  project: Pick<Project, 'kind'>,
  spec: Pick<Spec, 'status'> | null,
): ProjectMold {
  const classified = spec != null && spec.status !== 'pending';
  if (!classified) return 'unclassified';
  return isProjectKind(project.kind) ? project.kind : 'unclassified';
}

export interface MoldMeta {
  /** The mold key. */
  readonly mold: ProjectMold;
  /** Plural space title + nav label, e.g. 'Agents'. */
  readonly title: string;
  /** Short badge text, styled like the stage pill (lower-case mono). */
  readonly badgeLabel: string;
  /** One-line plain description shown atop a mold space. */
  readonly description: string;
  /** Per-mold empty-state line. */
  readonly emptyLine: string;
  /** Brand-token badge tone (border + text). */
  readonly tone: string;
  /** Route for the mold space, or null for 'unclassified' (Home only). */
  readonly href: string | null;
}

// Per-mold presentation. Badge tones reuse the palette the archive
// already established (system=cyan, software=emerald, infra=rose); agent
// gets the brand amber (it now wears a badge in its mold space), and
// unclassified is a quiet dim "Detecting…".
export const MOLD_META: Record<ProjectMold, MoldMeta> = {
  agent: {
    mold: 'agent',
    title: 'Agents',
    badgeLabel: 'agent',
    description: 'A single autonomous assistant.',
    emptyLine: 'No agents forged yet — describe one in New Forge.',
    tone: 'border-forge-amber/40 text-forge-amber',
    href: '/agents',
  },
  system: {
    mold: 'system',
    title: 'Systems',
    badgeLabel: 'system',
    description: 'Coordinated agents working together.',
    emptyLine: 'No systems forged yet — describe one in New Forge.',
    tone: 'border-forge-cyan/40 text-forge-cyan',
    href: '/systems',
  },
  software: {
    mold: 'software',
    title: 'Software',
    badgeLabel: 'software',
    description: 'A full web app with pages, data, and auth.',
    emptyLine: 'No software forged yet — describe one in New Forge.',
    tone: 'border-emerald-400/40 text-emerald-300',
    href: '/software',
  },
  infrastructure: {
    mold: 'infrastructure',
    title: 'Infrastructure',
    badgeLabel: 'infrastructure',
    description: 'The machinery underneath — data + runtime plumbing.',
    emptyLine: 'No infrastructure forged yet — describe some in New Forge.',
    tone: 'border-rose-400/40 text-rose-300',
    href: '/infrastructure',
  },
  unclassified: {
    mold: 'unclassified',
    title: 'Detecting',
    badgeLabel: 'detecting…',
    description: 'The Forge is still detecting this project’s type.',
    emptyLine: '',
    tone: 'border-white/10 text-forge-dim',
    href: null,
  },
};

/** The mold spaces, in display order (excludes 'unclassified'). */
export const MOLD_SPACES: ReadonlyArray<MoldMeta> = PROJECT_MOLDS.map(
  (m) => MOLD_META[m],
);

/**
 * Filter mold-tagged items down to a single mold. Pure — the mold-space
 * pages use it to list ONLY their mold; Home passes nothing and lists all.
 */
export function filterByMold<T extends { mold: ProjectMold }>(
  items: readonly T[],
  mold: ProjectMold,
): T[] {
  return items.filter((item) => item.mold === mold);
}
