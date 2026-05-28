// App nav model — the four molds are the PRIMARY spine. Pure + client-
// safe so the active-state logic is unit-testable without rendering.
//
//   PRIMARY: Home + the four mold spaces (Agents · Systems · Software ·
//            Infrastructure) — the organizing spine.
//   ACTION:  "+ New Forge" — the single unified intake (auto-detect); no
//            mold picker, reachable from anywhere.
//   GLOBAL:  Keys + Governance — cross-cutting utilities (keys + spend
//            caps span every mold). Visually secondary to the molds.

import { MOLD_SPACES } from '@/lib/molds';

export interface NavItem {
  readonly label: string;
  readonly href: string;
  /** Optional accent token for hover/active emphasis. */
  readonly accent?: 'amber' | 'cyan';
}

/** The unified intake action. Auto-detects the mold — never a picker. */
export const NEW_FORGE_HREF = '/forge';

/** Home (overview / all) + the four mold spaces, in order. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { label: 'Home', href: '/projects' },
  ...MOLD_SPACES.map((m): NavItem => ({ label: m.title, href: m.href! })),
];

/** Cross-cutting utilities, secondary to the molds. */
export const GLOBAL_NAV: readonly NavItem[] = [
  { label: 'Keys', href: '/settings/keys', accent: 'cyan' },
  { label: 'Governance', href: '/governance', accent: 'amber' },
];

/**
 * Is `href` the active nav target for the current `pathname`?
 *
 * Home ('/projects') matches EXACTLY — a project detail page
 * ('/projects/[id]') belongs to a mold and is reached via a card, so it
 * must not light up Home. Every other item matches itself or any nested
 * route under it.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/projects') return pathname === '/projects';
  return pathname === href || pathname.startsWith(href + '/');
}
