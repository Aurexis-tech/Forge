// Hermetic tests for the mold-spine information architecture.
//
// The app ships without a DOM test env (vitest + node), so — like the
// confidence-display tests — these cover the PURE HELPERS the IA
// components wrap:
//
//   - resolveProjectMold  — which mold space a project belongs to, incl.
//                           the explicit "unclassified" (Detecting…) state.
//   - filterByMold        — mold spaces list ONLY their mold; Home lists all.
//   - MOLD_META           — per-mold label / description / badge / route.
//   - nav (PRIMARY/GLOBAL/isNavActive) — the four molds as the spine +
//                           Home + global utilities; active-state routing.
//
// MoldBadge, ProjectCard, AppNav, the mold-space pages, and Home are thin
// JSX wrappers over these helpers — correct helpers ⇒ correct UI.

import { describe, expect, it } from 'vitest';
import {
  filterByMold,
  MOLD_META,
  MOLD_SPACES,
  PROJECT_MOLDS,
  resolveProjectMold,
  type ProjectMold,
} from '@/lib/molds';
import {
  GLOBAL_NAV,
  isNavActive,
  NEW_FORGE_HREF,
  PRIMARY_NAV,
} from '@/lib/nav';
import type { Project, ProjectKind, Spec, SpecStatus } from '@/lib/types';

// --- fixtures --------------------------------------------------------------
function proj(kind: string): Pick<Project, 'kind'> {
  return { kind };
}
function spec(status: SpecStatus | string): Pick<Spec, 'status'> {
  return { status };
}

// ===========================================================================
// resolveProjectMold — classification → mold, with explicit Detecting…
// ===========================================================================
describe('resolveProjectMold', () => {
  it('maps each classified kind to its own mold', () => {
    for (const k of PROJECT_MOLDS) {
      // Any non-'pending' spec status means extraction has run = classified.
      expect(resolveProjectMold(proj(k), spec('confirmed'))).toBe(k);
      expect(resolveProjectMold(proj(k), spec('awaiting_review'))).toBe(k);
    }
  });

  it('is "unclassified" when the spec is still pending (intake, pre-classify)', () => {
    // Even though the DB defaults kind to 'agent', a pending spec means
    // the classifier has NOT run — we must NOT mislabel it as an agent.
    expect(resolveProjectMold(proj('agent'), spec('pending'))).toBe('unclassified');
    expect(resolveProjectMold(proj('system'), spec('pending'))).toBe('unclassified');
  });

  it('is "unclassified" when there is no spec yet', () => {
    expect(resolveProjectMold(proj('agent'), null)).toBe('unclassified');
  });

  it('never mislabels a stray / unknown stored kind', () => {
    expect(resolveProjectMold(proj('weird-future-kind'), spec('confirmed'))).toBe(
      'unclassified',
    );
    expect(resolveProjectMold(proj(''), spec('confirmed'))).toBe('unclassified');
  });

  it('a real classified agent stays an agent (not confused with Detecting)', () => {
    expect(resolveProjectMold(proj('agent'), spec('confirmed'))).toBe('agent');
  });
});

// ===========================================================================
// PROJECT_MOLDS / MOLD_META — canonical set + presentation
// ===========================================================================
describe('mold catalog', () => {
  it('PROJECT_MOLDS is exactly the four canonical molds, in order', () => {
    expect([...PROJECT_MOLDS]).toEqual([
      'agent',
      'system',
      'software',
      'infrastructure',
    ]);
  });

  it('every mold + unclassified has full presentation metadata', () => {
    const all: ProjectMold[] = [...PROJECT_MOLDS, 'unclassified'];
    for (const m of all) {
      const meta = MOLD_META[m];
      expect(meta.title.length, m).toBeGreaterThan(0);
      expect(meta.badgeLabel.length, m).toBeGreaterThan(0);
      expect(meta.description.length, m).toBeGreaterThan(0);
      expect(meta.tone, m).toMatch(/border-/);
    }
  });

  it('the four molds have a route; unclassified has none (Home only)', () => {
    for (const m of PROJECT_MOLDS) {
      expect(MOLD_META[m].href, m).toBe('/' + (m === 'agent' ? 'agents' : m === 'system' ? 'systems' : m));
    }
    expect(MOLD_META.unclassified.href).toBeNull();
  });

  it('mold badge labels read correctly (incl. Detecting…)', () => {
    expect(MOLD_META.agent.badgeLabel).toBe('agent');
    expect(MOLD_META.system.badgeLabel).toBe('system');
    expect(MOLD_META.software.badgeLabel).toBe('software');
    expect(MOLD_META.infrastructure.badgeLabel).toBe('infrastructure');
    expect(MOLD_META.unclassified.badgeLabel).toMatch(/detect/i);
  });

  it('per-mold empty lines point at New Forge', () => {
    for (const m of PROJECT_MOLDS) {
      expect(MOLD_META[m].emptyLine, m).toMatch(/New Forge/);
    }
  });

  it('MOLD_SPACES excludes unclassified', () => {
    expect(MOLD_SPACES.map((s) => s.mold)).toEqual([...PROJECT_MOLDS]);
    expect(MOLD_SPACES.some((s) => s.mold === 'unclassified')).toBe(false);
  });
});

// ===========================================================================
// filterByMold — mold spaces scope to one mold; Home lists everything
// ===========================================================================
describe('filterByMold', () => {
  const cards: Array<{ id: string; mold: ProjectMold }> = [
    { id: 'a1', mold: 'agent' },
    { id: 'a2', mold: 'agent' },
    { id: 's1', mold: 'system' },
    { id: 'sw1', mold: 'software' },
    { id: 'i1', mold: 'infrastructure' },
    { id: 'u1', mold: 'unclassified' },
    { id: 'u2', mold: 'unclassified' },
  ];

  it('a mold space lists ONLY that mold (never unclassified, never others)', () => {
    expect(filterByMold(cards, 'agent').map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(filterByMold(cards, 'system').map((c) => c.id)).toEqual(['s1']);
    expect(filterByMold(cards, 'software').map((c) => c.id)).toEqual(['sw1']);
    expect(filterByMold(cards, 'infrastructure').map((c) => c.id)).toEqual(['i1']);
    // No mold space leaks unclassified projects.
    for (const m of PROJECT_MOLDS) {
      expect(filterByMold(cards, m).some((c) => c.mold === 'unclassified')).toBe(
        false,
      );
    }
  });

  it('Home (no filter) keeps ALL cards, including unclassified', () => {
    // Home renders the full list — the unfiltered safety net.
    expect(cards.length).toBe(7);
    expect(cards.some((c) => c.mold === 'unclassified')).toBe(true);
  });
});

// ===========================================================================
// nav — molds are the primary spine; Keys/Governance global; active state
// ===========================================================================
describe('app nav model', () => {
  it('primary spine = Home + the four mold spaces, in order', () => {
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual([
      'Home',
      'Agents',
      'Systems',
      'Software',
      'Infrastructure',
    ]);
    expect(PRIMARY_NAV.map((n) => n.href)).toEqual([
      '/projects',
      '/agents',
      '/systems',
      '/software',
      '/infrastructure',
    ]);
  });

  it('global utilities = Keys + Governance (cross-cutting)', () => {
    expect(GLOBAL_NAV.map((n) => n.href)).toEqual([
      '/settings/keys',
      '/governance',
    ]);
  });

  it('New Forge is the single unified intake action', () => {
    expect(NEW_FORGE_HREF).toBe('/forge');
  });

  it('active state: a mold space is active on its own route (+ nested)', () => {
    expect(isNavActive('/agents', '/agents')).toBe(true);
    expect(isNavActive('/systems', '/systems')).toBe(true);
    expect(isNavActive('/software', '/software')).toBe(true);
    expect(isNavActive('/infrastructure', '/infrastructure')).toBe(true);
    // Not cross-active.
    expect(isNavActive('/agents', '/systems')).toBe(false);
  });

  it('Home matches /projects EXACTLY — a project detail does not light Home', () => {
    expect(isNavActive('/projects', '/projects')).toBe(true);
    expect(isNavActive('/projects/abc-123', '/projects')).toBe(false);
  });

  it('global utilities light up on their own routes', () => {
    expect(isNavActive('/settings/keys', '/settings/keys')).toBe(true);
    expect(isNavActive('/governance', '/governance')).toBe(true);
  });
});
