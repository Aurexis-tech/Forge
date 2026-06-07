// Hermetic tests for the four mold-space migrations + the parameterized
// MoldSpaceAi. PURE checks against the mold-identity map + the aggregator;
// structural assertions for the route wiring, the reuse of ProjectCardAi,
// the mold-tinted empty state, and the allowlist + backdrop guards.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  Journey,
  JourneyStage,
  JourneyStageId,
  JourneyStageStatus,
} from '@/lib/journey';
import { isMigratedRoute, MIGRATED_ROUTES } from '@/lib/migrated-routes';
import { MOLD_IDENTITIES, MOLD_ORDER } from '@/lib/mold-identity';
import type { ProjectCardData } from '@/lib/project-cards';
import { aggregateMoldStats } from '@/lib/project-vm';
import type { ProjectKind } from '@/lib/types';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. Per-mold identity — pure, complete, correct accent + numbering
// ===========================================================================
describe('MOLD_IDENTITIES', () => {
  it('covers all four molds in canonical order', () => {
    expect([...MOLD_ORDER]).toEqual([
      'agent',
      'system',
      'software',
      'infrastructure',
    ]);
    for (const m of MOLD_ORDER) {
      expect(MOLD_IDENTITIES[m]).toBeDefined();
    }
  });

  it('Agents = aurora (01/04), tagline "your watchers"', () => {
    const a = MOLD_IDENTITIES.agent;
    expect(a.accent).toBe('aurora');
    expect(a.ordinal).toBe(1);
    expect(a.name).toBe('Agents');
    expect(a.tagline).toBe('your watchers');
    expect(a.eyebrow).toBe('Mold · 01 / 04 · Agents');
    expect(a.href).toBe('/agents');
    expect(a.emptyHeading).toBe('No agents yet.');
    expect(a.ctaLabel).toMatch(/Forge a new agent/);
  });

  it('Systems = blue (02/04), tagline "coordinated"', () => {
    const s = MOLD_IDENTITIES.system;
    expect(s.accent).toBe('blue');
    expect(s.ordinal).toBe(2);
    expect(s.name).toBe('Systems');
    expect(s.tagline).toBe('coordinated');
    expect(s.href).toBe('/systems');
  });

  it('Software = violet (03/04), tagline "the apps"', () => {
    const s = MOLD_IDENTITIES.software;
    expect(s.accent).toBe('violet');
    expect(s.ordinal).toBe(3);
    expect(s.name).toBe('Software');
    expect(s.tagline).toBe('the apps');
    expect(s.href).toBe('/software');
  });

  it('Infrastructure = magenta (04/04), tagline "the machinery"', () => {
    const i = MOLD_IDENTITIES.infrastructure;
    expect(i.accent).toBe('magenta');
    expect(i.ordinal).toBe(4);
    expect(i.name).toBe('Infrastructure');
    expect(i.tagline).toBe('the machinery');
    expect(i.href).toBe('/infrastructure');
  });

  it('every mold has a description AND a unique empty-state invitation', () => {
    const invites = new Set<string>();
    for (const m of MOLD_ORDER) {
      const id = MOLD_IDENTITIES[m];
      expect(id.description.length, m).toBeGreaterThan(20);
      expect(id.emptyInvitation.length, m).toBeGreaterThan(10);
      invites.add(id.emptyInvitation);
    }
    expect(invites.size).toBe(4);
  });
});

// ===========================================================================
// 2. aggregateMoldStats — pure, derives only REAL fields
// ===========================================================================
const STAGE_DEFS: ReadonlyArray<{ id: JourneyStageId; label: string }> = [
  { id: 'intent', label: 'Intent' },
  { id: 'spec', label: 'Spec' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'Code' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'repo', label: 'Repo' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'runtime', label: 'Live' },
];

function buildCard(opts: {
  mold?: 'agent' | 'system' | 'software' | 'infrastructure' | 'unclassified';
  status?: string;
  cursorIndex?: number;
  cursorStatus?: JourneyStageStatus;
  cursorDetail?: string;
  isLive?: boolean;
  id?: string;
}): ProjectCardData {
  const stages: JourneyStage[] = STAGE_DEFS.map((def, i) => {
    let status: JourneyStageStatus = 'pending';
    if (i < (opts.cursorIndex ?? 2)) status = 'done';
    if (i === (opts.cursorIndex ?? 2)) status = opts.cursorStatus ?? 'current';
    return {
      id: def.id,
      label: def.label,
      index: i + 1,
      detail: i === (opts.cursorIndex ?? 2) ? (opts.cursorDetail ?? '') : '',
      status,
    };
  });
  const journey: Journey = {
    stages,
    cursor: stages[opts.cursorIndex ?? 2]!,
    isLive: opts.isLive ?? false,
    isRuntimeMode: false,
  };
  return {
    project: {
      id: opts.id ?? 'p',
      user_id: 'u',
      name: 'proj',
      status: opts.status ?? 'building',
      kind: (opts.mold === 'unclassified' ? 'agent' : opts.mold) ?? 'agent',
      created_at: '2026-05-29T12:00:00.000Z',
    },
    journey,
    mold: opts.mold ?? 'agent',
  };
}

describe('aggregateMoldStats', () => {
  it('counts total + per-status (live / forging / gate) from real fields', () => {
    const cards: ProjectCardData[] = [
      buildCard({ id: 'a', isLive: true, cursorIndex: 7, cursorStatus: 'done' }),
      buildCard({
        id: 'b',
        cursorIndex: 6,
        cursorStatus: 'current',
        cursorDetail: 'awaiting authorisation',
      }),
      buildCard({ id: 'c', cursorIndex: 3, cursorStatus: 'current' }),
      buildCard({ id: 'd', cursorIndex: 3, cursorStatus: 'current' }),
    ];
    expect(aggregateMoldStats(cards)).toEqual({
      total: 4,
      live: 1,
      forging: 2,
      gate: 1,
    });
  });

  it('NEVER emits fabricated fields (runs / uptime / cost)', () => {
    const out = aggregateMoldStats([buildCard({})]);
    expect(Object.keys(out).sort()).toEqual(['forging', 'gate', 'live', 'total']);
  });

  it('empty list → all zeros', () => {
    expect(aggregateMoldStats([])).toEqual({
      total: 0,
      live: 0,
      forging: 0,
      gate: 0,
    });
  });
});

// ===========================================================================
// 3. MIGRATED_ROUTES + isMigratedRoute (exact match) — the four molds added
// ===========================================================================
describe('MIGRATED_ROUTES now covers the four mold spaces', () => {
  it('includes /agents, /systems, /software, /infrastructure', () => {
    for (const r of ['/agents', '/systems', '/software', '/infrastructure']) {
      expect(MIGRATED_ROUTES).toContain(r);
    }
    // Sanity: the earlier migrations are still in there.
    expect(MIGRATED_ROUTES).toContain('/forge');
    expect(MIGRATED_ROUTES).toContain('/projects');
  });

  it('each mold route matches EXACTLY (children stay un-migrated)', () => {
    for (const r of ['/agents', '/systems', '/software', '/infrastructure']) {
      expect(isMigratedRoute(r)).toBe(true);
      expect(isMigratedRoute(r + '/something')).toBe(false);
    }
    // A representative un-migrated route still goes to ForgeBackdrop.
    expect(isMigratedRoute('/settings/connections')).toBe(false);
  });
});

// ===========================================================================
// 4. The four route pages render the parameterized MoldSpaceAi
// ===========================================================================
describe('mold-space routes mount the new parameterized component', () => {
  const cases: ReadonlyArray<{ path: string; mold: ProjectKind }> = [
    { path: 'app/(app)/agents/page.tsx', mold: 'agent' },
    { path: 'app/(app)/systems/page.tsx', mold: 'system' },
    { path: 'app/(app)/software/page.tsx', mold: 'software' },
    { path: 'app/(app)/infrastructure/page.tsx', mold: 'infrastructure' },
  ];
  for (const c of cases) {
    it(`${c.path} renders <MoldSpaceAi mold="${c.mold}" />`, () => {
      const src = read(c.path);
      expect(src).toMatch(
        new RegExp(`<MoldSpaceAi mold="${c.mold}"\\s*/>`),
      );
      // The forge MoldSpacePage is no longer the rendering component.
      expect(src).not.toMatch(/from '@\/components\/MoldSpacePage'/);
    });
  }
});

// ===========================================================================
// 5. MoldSpaceAi — REUSES ProjectCardAi via MoldGrid, omits cost fabricator
// ===========================================================================
describe('MoldSpaceAi server component', () => {
  const src = read('components/projects-ai/MoldSpaceAi.tsx');

  it('reuses MoldGrid + the projectVm aggregator + filterByMold (no fork)', () => {
    expect(src).toMatch(/from '@\/components\/projects-ai\/MoldGrid'/);
    expect(src).toMatch(/aggregateMoldStats/);
    expect(src).toMatch(/filterByMold/);
  });

  it('drives identity from the pure MOLD_IDENTITIES map', () => {
    expect(src).toMatch(/MOLD_IDENTITIES\[mold\]/);
    expect(src).toMatch(/MOLD_ORDER/);
  });

  it('preserves the loader (loadProjectCards) and the requireUser gate', () => {
    expect(src).toMatch(/loadProjectCards/);
    expect(src).toMatch(/requireUser/);
  });

  it('aggregate bar shows only total/live/forging/gate (no fabricated runs/uptime/cost)', () => {
    expect(src).toMatch(/total/);
    expect(src).toMatch(/live/);
    expect(src).toMatch(/forging/);
    expect(src).toMatch(/gate/);
    // No "runs" / "uptime" / "cost" / "spend" surfaced on the aggregate bar.
    // (The per-project card may show these as "—"; the aggregate must not
    // invent numbers for them.)
    const aggregateBlock =
      src.match(
        /Aggregate stat bar[\s\S]*?<\/p>/,
      )?.[0] ?? '';
    expect(aggregateBlock).not.toMatch(/runs/i);
    expect(aggregateBlock).not.toMatch(/uptime/i);
    expect(aggregateBlock).not.toMatch(/cost/i);
  });

  it('switcher renders all four molds with real counts + the current as the active accent', () => {
    expect(src).toMatch(/countsByMold/);
    expect(src).toMatch(/active \? 'aurora' : 'default'/);
  });

  it('"+ Forge new …" is a PLAIN /forge link (intake is mold-agnostic)', () => {
    expect(src).toMatch(/href="\/forge"/);
    expect(src).toMatch(/identity\.ctaLabel/);
  });
});

// ===========================================================================
// 6. MoldGrid — REUSES ProjectCardAi; status chips; mold-tinted empty state
// ===========================================================================
describe('MoldGrid client', () => {
  const src = read('components/projects-ai/MoldGrid.tsx');

  it('is a client component reusing ProjectCardAi (not a fork)', () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/ProjectCardAi/);
    expect(src).toMatch(/from '@\/components\/projects-ai\/ProjectCardAi'/);
  });

  it('renders status chips (All / Live / Forging / Gate)', () => {
    expect(src).toMatch(/STATUS_CHIPS/);
    expect(src).toMatch(/Live/);
    expect(src).toMatch(/Forging/);
    expect(src).toMatch(/Gate/);
  });

  it('renders the mold-tinted empty state (PRIMARY) from MOLD_IDENTITIES', () => {
    expect(src).toMatch(/MOLD_IDENTITIES\[mold\]/);
    expect(src).toMatch(/identity\.emptyHeading/);
    expect(src).toMatch(/identity\.emptyInvitation/);
    expect(src).toMatch(/identity\.ctaLabel/);
    expect(src).toMatch(/ACCENT_BORDER\[identity\.accent\]/);
  });

  it('renders a secondary empty state when chips narrow real data to nothing', () => {
    expect(src).toMatch(/match the current filters/);
    expect(src).toMatch(/setStatusKey\('all'\)/);
  });
});

// ===========================================================================
// 7. Module / globals discipline — no new module added; globals stays at 4
// ===========================================================================
describe('infinite-animation budget', () => {
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the existing projects module is unchanged at ONE infinite loop', () => {
    expect(countInfinite('components/projects-ai/projects.module.css')).toBe(1);
  });

  it('globals.css still ≤4 infinite loops', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
  });
});
