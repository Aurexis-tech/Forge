// Hermetic tests for the /projects migration.
//
// node-only: pure projectVm mapping from fixture ProjectCardData + source
// assertions for the page wiring (loader preserved), the filter/sort chips
// (reuses filterByMold), the FIRST-CLASS empty state, the card variants,
// the backdrop-switch allowlist, and the module-scoped infinite loop.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  Journey,
  JourneyStage,
  JourneyStageId,
  JourneyStageStatus,
} from '@/lib/journey';
import type { ProjectCardData } from '@/lib/project-cards';
import type { ProjectMold } from '@/lib/molds';
import {
  deriveStatus,
  projectVm,
  type ProjectVmStatus,
} from '@/lib/project-vm';
import { isMigratedRoute, MIGRATED_ROUTES } from '@/lib/migrated-routes';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// Fixture helpers — build ProjectCardData inputs deterministically
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

function buildJourney(opts: {
  cursorIndex: number;
  cursorStatus?: JourneyStageStatus;
  cursorDetail?: string;
  isLive?: boolean;
}): Journey {
  const stages: JourneyStage[] = STAGE_DEFS.map((def, i) => {
    let status: JourneyStageStatus = 'pending';
    if (i < opts.cursorIndex) status = 'done';
    if (i === opts.cursorIndex) status = opts.cursorStatus ?? 'current';
    return {
      id: def.id,
      label: def.label,
      index: i + 1,
      detail: i === opts.cursorIndex ? (opts.cursorDetail ?? '') : '',
      status,
    };
  });
  return {
    stages,
    cursor: stages[opts.cursorIndex]!,
    isLive: opts.isLive ?? false,
    isRuntimeMode: false,
  };
}

function buildCard(opts: {
  mold?: ProjectMold;
  status?: string;
  name?: string;
  id?: string;
  createdAt?: string;
  cursorIndex?: number;
  cursorStatus?: JourneyStageStatus;
  cursorDetail?: string;
  isLive?: boolean;
}): ProjectCardData {
  return {
    project: {
      id: opts.id ?? 'p1',
      user_id: 'u1',
      name: opts.name ?? 'arxiv-morning-brief',
      status: opts.status ?? 'building',
      kind: opts.mold === 'unclassified' ? 'agent' : (opts.mold ?? 'agent'),
      created_at: opts.createdAt ?? '2026-05-29T12:00:00.000Z',
    },
    journey: buildJourney({
      cursorIndex: opts.cursorIndex ?? 2,
      cursorStatus: opts.cursorStatus,
      cursorDetail: opts.cursorDetail,
      isLive: opts.isLive,
    }),
    mold: opts.mold ?? 'agent',
  };
}

const NOW = new Date('2026-05-29T13:00:00.000Z').getTime();

// ===========================================================================
// 1. deriveStatus — the headline state mapping (PURE)
// ===========================================================================
describe('deriveStatus', () => {
  it("returns 'detecting' for unclassified projects (mold not yet detected)", () => {
    expect(deriveStatus(buildCard({ mold: 'unclassified' }))).toBe('detecting');
  });

  it("returns 'live' when journey.isLive (and not paused)", () => {
    expect(
      deriveStatus(
        buildCard({
          mold: 'agent',
          cursorIndex: 7,
          cursorStatus: 'done',
          cursorDetail: 'active · 12 runs',
          isLive: true,
        }),
      ),
    ).toBe('live');
  });

  it("returns 'paused' when project.status is paused", () => {
    expect(
      deriveStatus(buildCard({ mold: 'agent', status: 'paused' })),
    ).toBe('paused');
  });

  it("returns 'paused' when isLive but cursor.detail says paused/offline", () => {
    expect(
      deriveStatus(
        buildCard({
          mold: 'software',
          cursorIndex: 7,
          cursorStatus: 'done',
          cursorDetail: 'offline · paused',
          isLive: true,
        }),
      ),
    ).toBe('paused');
  });

  it("returns 'gate' when the current stage is awaiting a human decision", () => {
    expect(
      deriveStatus(
        buildCard({
          mold: 'agent',
          cursorIndex: 6,
          cursorStatus: 'current',
          cursorDetail: 'awaiting authorisation',
        }),
      ),
    ).toBe('gate');
  });

  it("returns 'forging' for an in-progress, non-gate stage", () => {
    expect(
      deriveStatus(
        buildCard({
          mold: 'agent',
          cursorIndex: 3,
          cursorStatus: 'current',
          cursorDetail: 'generating…',
        }),
      ),
    ).toBe('forging');
  });
});

// ===========================================================================
// 2. projectVm — full mapping (mold → accent, stats with "—" fallback, dots)
// ===========================================================================
describe('projectVm', () => {
  it('maps mold → accent + label (Agent=aurora, System=violet, Software=mint, Infrastructure=amber)', () => {
    expect(projectVm(buildCard({ mold: 'agent' }), { nowMs: NOW }).moldAccent).toBe('aurora');
    expect(projectVm(buildCard({ mold: 'system' }), { nowMs: NOW }).moldAccent).toBe('violet');
    expect(projectVm(buildCard({ mold: 'software' }), { nowMs: NOW }).moldAccent).toBe('mint');
    expect(projectVm(buildCard({ mold: 'infrastructure' }), { nowMs: NOW }).moldAccent).toBe('amber');
    const detecting = projectVm(buildCard({ mold: 'unclassified' }), { nowMs: NOW });
    expect(detecting.moldAccent).toBeNull();
    expect(detecting.moldLabel).toMatch(/Detecting/);
  });

  it('renders 3 stats per status (with "—" for fields we don\'t plumb)', () => {
    const live = projectVm(
      buildCard({ mold: 'agent', isLive: true, cursorIndex: 7, cursorStatus: 'done' }),
      { nowMs: NOW },
    );
    expect(live.stats.map((s) => s.label)).toEqual(['runs', 'cost', 'uptime']);
    expect(live.stats.every((s) => s.value === '—')).toBe(true);

    const forging = projectVm(buildCard({ mold: 'agent', cursorIndex: 3 }), { nowMs: NOW });
    expect(forging.stats.map((s) => s.label)).toEqual(['age', 'spend', 'cache']);
    expect(forging.stats[0]!.value).toMatch(/(just now|m|h|d|mo ago)/);
    expect(forging.stats[1]!.value).toBe('—');
    expect(forging.stats[2]!.value).toBe('—');

    const gate = projectVm(
      buildCard({
        mold: 'agent',
        cursorIndex: 6,
        cursorStatus: 'current',
        cursorDetail: 'awaiting authorisation',
      }),
      { nowMs: NOW },
    );
    expect(gate.stats[0]!.label).toBe('action');
    expect(gate.stats[0]!.value).toMatch(/approve/);

    const paused = projectVm(buildCard({ mold: 'agent', status: 'paused' }), { nowMs: NOW });
    expect(paused.stats[0]!.value).toBe('paused');

    const detecting = projectVm(buildCard({ mold: 'unclassified' }), { nowMs: NOW });
    expect(detecting.stats.every((s) => s.value === '—')).toBe(true);
  });

  it('mini-pipeline is REAL — 8 dots, derived from journey.stages', () => {
    const vm = projectVm(buildCard({ mold: 'agent', cursorIndex: 3 }), { nowMs: NOW });
    expect(vm.dots).toHaveLength(8);
    // Before cursor: done → aurora-soft. At cursor: current → aurora + pulse.
    // After cursor: pending → ghost.
    expect(vm.dots[0]!.tone).toBe('aurora-soft');
    expect(vm.dots[2]!.tone).toBe('aurora-soft');
    expect(vm.dots[3]!.tone).toBe('aurora');
    expect(vm.dots[3]!.pulse).toBe(true);
    expect(vm.dots[7]!.tone).toBe('ghost');
    expect(vm.dots[7]!.pulse).toBe(false);
  });

  it('GATE active dot is amber (Repo / Deploy / Confirm), not aurora', () => {
    const vm = projectVm(
      buildCard({
        mold: 'agent',
        cursorIndex: 6, // deploy
        cursorStatus: 'current',
        cursorDetail: 'awaiting authorisation',
      }),
      { nowMs: NOW },
    );
    expect(vm.status).toBe('gate');
    expect(vm.dots[6]!.tone).toBe('amber');
    expect(vm.dots[6]!.pulse).toBe(true);
  });

  it('LIVE terminal dot is mint + pulses', () => {
    const vm = projectVm(
      buildCard({
        mold: 'agent',
        cursorIndex: 7,
        cursorStatus: 'done',
        cursorDetail: 'active · 3 runs',
        isLive: true,
      }),
      { nowMs: NOW },
    );
    expect(vm.status).toBe('live');
    expect(vm.dots[7]!.tone).toBe('mint');
    expect(vm.dots[7]!.pulse).toBe(true);
  });

  it('PAUSED terminal dot is dimmed (aurora-soft, no pulse)', () => {
    const vm = projectVm(
      buildCard({ mold: 'agent', status: 'paused', cursorIndex: 7, cursorStatus: 'done' }),
      { nowMs: NOW },
    );
    expect(vm.status).toBe('paused');
    expect(vm.dots[7]!.tone).toBe('aurora-soft');
    expect(vm.dots[7]!.pulse).toBe(false);
  });
});

// ===========================================================================
// 3. The (app) migrated-route allowlist — /projects added, EXACT match
// ===========================================================================
describe('MIGRATED_ROUTES now covers /projects (exact match)', () => {
  it('lists /forge and /projects (further migrations may add more)', () => {
    expect(MIGRATED_ROUTES).toContain('/forge');
    expect(MIGRATED_ROUTES).toContain('/projects');
  });

  it('matches /projects EXACTLY and never a child (the detail page stays un-migrated)', () => {
    expect(isMigratedRoute('/projects')).toBe(true);
    expect(isMigratedRoute('/projects/abc-123')).toBe(false);
    expect(isMigratedRoute('/forge')).toBe(true);
    expect(isMigratedRoute('/forge/anything')).toBe(false);
    expect(isMigratedRoute('/governance')).toBe(false);
  });
});

// ===========================================================================
// 4. /projects page wiring — loader preserved, ProjectsAi mounted
// ===========================================================================
describe('/projects page wiring', () => {
  const page = read('app/(app)/projects/page.tsx');

  it('still uses loadProjectCards (the loader is preserved)', () => {
    expect(page).toMatch(/loadProjectCards/);
  });

  it('renders the new ProjectsAi client component (no forge ProjectCard)', () => {
    expect(page).toMatch(/<ProjectsAi cards=\{cards\}/);
    expect(page).not.toMatch(/from '@\/components\/ProjectCard'/);
    expect(page).not.toMatch(/SectionHeader/);
    expect(page).not.toMatch(/forge-amber/);
  });
});

// ===========================================================================
// 5. ProjectsAi — chips reuse filterByMold; sort + count summary + empty state
// ===========================================================================
describe('ProjectsAi shell', () => {
  const src = read('components/projects-ai/ProjectsAi.tsx');

  it("is a client component composing the lq primitives + lq tokens + font-ui", () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/text-lq-aurora/);
    expect(src).toMatch(/font-ui/);
  });

  it('REUSES filterByMold (preserves the existing filter semantic)', () => {
    expect(src).toMatch(/from '@\/lib\/molds'/);
    expect(src).toMatch(/filterByMold/);
  });

  it('annotates with projectVm status and filters by it (status chips)', () => {
    expect(src).toMatch(/projectVm\(c\)\.status/);
    expect(src).toMatch(/STATUS_CHIPS/);
  });

  it('count summary derives from REAL annotated cards (not hard-coded)', () => {
    expect(src).toMatch(/counts/);
    expect(src).toMatch(/counts\.total/);
    expect(src).toMatch(/counts\.live/);
    expect(src).toMatch(/counts\.gate/);
    expect(src).toMatch(/counts\.paused/);
  });

  it('renders a PRIMARY empty state when there are zero projects today', () => {
    expect(src).toMatch(/No projects yet\./);
    expect(src).toMatch(/Forge your first project/);
    expect(src).toMatch(/href="\/forge"/);
  });

  it('renders a secondary empty state when filters match nothing', () => {
    expect(src).toMatch(/No projects match/);
    expect(src).toMatch(/Reset filters/);
  });

  it('sort toggle has Newest / Oldest (preserves the loader\'s newest-first order)', () => {
    expect(src).toMatch(/Newest/);
    expect(src).toMatch(/Oldest/);
  });
});

// ===========================================================================
// 6. ProjectCardAi — pure renderer over projectVm
// ===========================================================================
describe('ProjectCardAi card', () => {
  const src = read('components/projects-ai/ProjectCardAi.tsx');

  it("renders LiquidGlass + lq.* + 8 pipeline dots via vm.dots", () => {
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/text-lq-ink/);
    expect(src).toMatch(/vm\.dots\.map/);
    expect(src).toMatch(/DOT_BG/);
  });

  it("uses projectVm + projects.module.css pulse for active dots", () => {
    expect(src).toMatch(/projectVm/);
    expect(src).toMatch(/styles\.pulseDot/);
  });

  it("dims the whole card when status === 'paused'", () => {
    expect(src).toMatch(/dimmed/);
    expect(src).toMatch(/opacity-60/);
  });
});

// ===========================================================================
// 7. Infinite-animation budget — module loop count + globals.css enforcer
// ===========================================================================
describe('infinite-animation budget', () => {
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the projects module has exactly ONE infinite loop (the pulse dot)', () => {
    expect(countInfinite('components/projects-ai/projects.module.css')).toBe(1);
  });

  it('globals.css still ≤4 infinite loops (projects keyframes never leaked)', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    expect(read('app/globals.css')).not.toMatch(/projectsPulse/);
  });
});
