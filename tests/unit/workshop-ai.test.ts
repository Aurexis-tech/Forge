// Hermetic tests for the Project Detail (workshop) migration. The honesty
// constraints (REAL forge state, NO fake typewriter, NO artificial stat
// ticking, NO fabricated timeline) are encoded as assertions: the view-
// model is pure and deterministic; the page binds to the real engine APIs
// (deriveJourney + getProjectSpend) and renders WorkshopShell + the
// untouched domain panels; the allowlist pattern correctly migrates
// /projects/[id] while keeping deeper children un-migrated; the code path
// is preserved as a real reveal (no typewriter / no fabricated code
// string).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  headerMetaVm,
  headerStatusVm,
  phaseForStage,
  phasesVm,
  pipelineDotsVm,
} from '@/lib/workshop-vm';
import {
  isMigratedRoute,
  MIGRATED_PATTERNS,
  MIGRATED_ROUTES,
} from '@/lib/migrated-routes';
import type { Journey, JourneyStage, JourneyStageId } from '@/lib/journey';

const read = (p: string) => readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// Test fixtures — build small Journey objects without touching deriveJourney
// (which has heavy dependencies). The shape matches what the real function
// returns; we exercise the pure VM layer on top.
// ---------------------------------------------------------------------------
function makeStage(
  id: JourneyStageId,
  index: number,
  status: JourneyStage['status'],
): JourneyStage {
  return { id, index, label: id.toUpperCase(), detail: '', status };
}

function makeJourney(opts: {
  cursor: JourneyStageId;
  cursorStatus?: JourneyStage['status'];
  isLive?: boolean;
}): Journey {
  const stages: JourneyStage[] = (
    ['intent', 'spec', 'plan', 'code', 'sandbox', 'repo', 'deploy', 'runtime'] as const
  ).map((id, i) => {
    if (id === opts.cursor) {
      return makeStage(id, i + 1, opts.cursorStatus ?? 'current');
    }
    return makeStage(id, i + 1, 'pending');
  });
  const cursor = stages.find((s) => s.id === opts.cursor)!;
  return {
    stages,
    cursor,
    isLive: opts.isLive ?? false,
    isRuntimeMode: false,
  };
}

// ===========================================================================
// 1. headerStatusVm — real journey + project status → real pill
// ===========================================================================
describe('headerStatusVm — pure status mapping', () => {
  it('live wins over everything else (mint, no pulse)', () => {
    const vm = headerStatusVm({
      journey: makeJourney({ cursor: 'runtime', isLive: true }),
      projectStatus: 'whatever',
    });
    expect(vm).toEqual({ label: 'live', color: 'mint', pulse: false });
  });

  it('cursor in `current` state → aurora "forging" with pulse', () => {
    const vm = headerStatusVm({
      journey: makeJourney({ cursor: 'code', cursorStatus: 'current' }),
      projectStatus: 'building',
    });
    expect(vm).toEqual({ label: 'forging', color: 'aurora', pulse: true });
  });

  it('cursor in `blocked` state → amber "gate-awaiting" with pulse', () => {
    const vm = headerStatusVm({
      journey: makeJourney({ cursor: 'repo', cursorStatus: 'blocked' }),
      projectStatus: 'tested',
    });
    expect(vm).toEqual({ label: 'gate-awaiting', color: 'amber', pulse: true });
  });

  it('cursor in `failed` → rose, no pulse', () => {
    const vm = headerStatusVm({
      journey: makeJourney({ cursor: 'sandbox', cursorStatus: 'failed' }),
      projectStatus: 'test_failed',
    });
    expect(vm.color).toBe('rose');
    expect(vm.pulse).toBe(false);
  });

  it('cursor in `pending` falls back to the REAL project status word', () => {
    const vm = headerStatusVm({
      journey: makeJourney({ cursor: 'spec', cursorStatus: 'pending' }),
      projectStatus: 'created',
    });
    expect(vm.label).toBe('created');
    expect(vm.color).toBe('ink-dim');
  });
});

// ===========================================================================
// 2. pipelineDotsVm — one VM per real stage, AI palette per status
// ===========================================================================
describe('pipelineDotsVm — pure stage → dot mapping', () => {
  it('emits exactly one dot per stage', () => {
    const dots = pipelineDotsVm(
      makeJourney({ cursor: 'plan', cursorStatus: 'current' }),
    );
    expect(dots).toHaveLength(8);
  });

  it('current stage breathes (pulse=true) — and only that one', () => {
    const dots = pipelineDotsVm(
      makeJourney({ cursor: 'code', cursorStatus: 'current' }),
    );
    const pulsing = dots.filter((d) => d.pulse);
    expect(pulsing).toHaveLength(1);
    expect(pulsing[0]!.id).toBe('code');
    expect(pulsing[0]!.color).toBe('amber');
  });

  it('done stages cool to aurora; pending sit ink-dim; failed glow rose', () => {
    const j = makeJourney({ cursor: 'sandbox', cursorStatus: 'failed' });
    // Manually mark stage 1 (intent) as done to exercise the done branch.
    (j.stages[0] as { status: JourneyStage['status'] }).status = 'done';
    const dots = pipelineDotsVm(j);
    expect(dots[0]!.color).toBe('aurora');
    const failedDot = dots.find((d) => d.id === 'sandbox')!;
    expect(failedDot.color).toBe('rose');
    const pendingDot = dots.find((d) => d.id === 'runtime')!;
    expect(pendingDot.color).toBe('ink-dim');
  });
});

// ===========================================================================
// 3. phaseForStage + phasesVm — closed mapping, exhaustive over real ids
// ===========================================================================
describe('phaseForStage — closed mapping over real JourneyStageId', () => {
  it('maps intent + spec → spec; plan → plan; code/sandbox/provision/preview/confirm/repo/deploy → code; runtime → live', () => {
    expect(phaseForStage('intent')).toBe('spec');
    expect(phaseForStage('spec')).toBe('spec');
    expect(phaseForStage('plan')).toBe('plan');
    expect(phaseForStage('code')).toBe('code');
    expect(phaseForStage('sandbox')).toBe('code');
    expect(phaseForStage('provision')).toBe('code');
    expect(phaseForStage('preview')).toBe('code');
    expect(phaseForStage('confirm')).toBe('code');
    expect(phaseForStage('repo')).toBe('code');
    expect(phaseForStage('deploy')).toBe('code');
    expect(phaseForStage('runtime')).toBe('live');
  });
});

describe('phasesVm — one active phase per journey, decided by cursor', () => {
  it('a cursor on `plan` activates the plan phase, others inactive', () => {
    const phases = phasesVm(
      makeJourney({ cursor: 'plan', cursorStatus: 'current' }),
    );
    expect(phases).toHaveLength(4);
    expect(phases.filter((p) => p.active)).toHaveLength(1);
    expect(phases.find((p) => p.active)?.id).toBe('plan');
  });

  it('a live runtime activates the live phase', () => {
    const phases = phasesVm(
      makeJourney({ cursor: 'runtime', isLive: true }),
    );
    expect(phases.find((p) => p.active)?.id).toBe('live');
  });
});

// ===========================================================================
// 4. headerMetaVm — real fields only (no fabricated tokens/latency)
// ===========================================================================
describe('headerMetaVm — only what the system actually tracks', () => {
  it('shortens the id, formats created_at, and formats real spend', () => {
    const vm = headerMetaVm({
      projectId: '1f8b3c2a-4567-890a-bcde-f0123456789a',
      createdAtIso: '2026-05-30T12:00:00Z',
      costToDateUsd: 0.1234,
    });
    expect(vm.idShort).toBe('1f8b3c2a');
    expect(vm.spendLabel).toBe('$0.1234');
    // The format string is locale-sensitive; we only check it's non-empty.
    expect(vm.createdLabel.length).toBeGreaterThan(0);
  });

  it('returns null spendLabel when there are no real cost events', () => {
    const vm = headerMetaVm({
      projectId: 'p',
      createdAtIso: '2026-05-30T12:00:00Z',
      costToDateUsd: 0,
    });
    expect(vm.spendLabel).toBeNull();
  });

  it('does NOT expose tokens / latency / cache fields (not tracked per-project)', () => {
    const vm = headerMetaVm({
      projectId: 'p',
      createdAtIso: '2026-05-30T12:00:00Z',
      costToDateUsd: 1.23,
    });
    expect(Object.keys(vm).sort()).toEqual(['createdLabel', 'idShort', 'spendLabel']);
  });
});

// ===========================================================================
// 5. Allowlist pattern — /projects/[id] migrated, deeper child stays not
// ===========================================================================
describe('isMigratedRoute pattern match — /projects/[id]', () => {
  it('the pattern array contains a project-detail regex', () => {
    expect(MIGRATED_PATTERNS.length).toBeGreaterThan(0);
    const hasProjectDetail = MIGRATED_PATTERNS.some((p) =>
      p.test('/projects/some-uuid'),
    );
    expect(hasProjectDetail).toBe(true);
  });

  it('/projects/[id] is migrated; /projects stays migrated; a deeper child stays NOT migrated', () => {
    expect(isMigratedRoute('/projects/abc-123')).toBe(true);
    expect(isMigratedRoute('/projects/1f8b3c2a-4567-890a-bcde-f0123456789a')).toBe(true);
    expect(isMigratedRoute('/projects')).toBe(true);
    // Deeper children deliberately stay un-migrated.
    expect(isMigratedRoute('/projects/abc-123/runs')).toBe(false);
    expect(isMigratedRoute('/projects/abc-123/anything')).toBe(false);
  });

  it('an un-migrated dynamic route still goes to ForgeBackdrop', () => {
    expect(isMigratedRoute('/settings/connections')).toBe(false);
    expect(isMigratedRoute('/projects/abc-123/extra')).toBe(false);
  });

  it('the exact list still wins (literal /projects is in MIGRATED_ROUTES)', () => {
    expect(MIGRATED_ROUTES).toContain('/projects');
  });
});

// ===========================================================================
// 6. The route page — preserves real data binding + real-time mechanism
// ===========================================================================
describe('/projects/[id] page wiring', () => {
  const page = read('app/(app)/projects/[id]/page.tsx');

  it('renders the new WorkshopShell (not the forge SectionHeader/EmberCard chrome)', () => {
    expect(page).toMatch(/<WorkshopShell/);
    expect(page).not.toMatch(/<SectionHeader/);
    expect(page).not.toMatch(/<HeatBadge\b/);
    expect(page).not.toMatch(/<StagePipeline\b/);
    expect(page).not.toMatch(/<EmberCard\b/);
  });

  it('still binds to the REAL engine APIs (deriveJourney + getProjectSpend)', () => {
    expect(page).toMatch(/deriveJourney\(/);
    expect(page).toMatch(/getProjectSpend\(project\.id\)/);
  });

  it('PRESERVES the real-time mechanism (LiveTailWrapper polling via ForgeTimelinePanel)', () => {
    // The timeline panel is left intact (the next prompt will restyle it),
    // and it's the wrapper that mounts the 5s router.refresh() polling.
    expect(page).toMatch(/renderForgeTimeline\(project\.id\)/);
    expect(page).toMatch(/ForgeTimelinePanel/);
  });

  it('PRESERVES the existing domain panels (gates stay functional)', () => {
    // A representative sample — these are the area subroutines that
    // contain the AuthorizationGate flows. They MUST still be rendered.
    expect(page).toMatch(/<SpecArea/);
    expect(page).toMatch(/SystemPlanArea/);
    expect(page).toMatch(/SoftwarePlanArea/);
    expect(page).toMatch(/InfraPlanArea/);
    expect(page).toMatch(/PlanArea/);
  });

  it('emits NO fake typewriter / fake activity / fabricated timeline arrays', () => {
    expect(page).not.toMatch(/typewriter/i);
    expect(page).not.toMatch(/fakeEvents/i);
    expect(page).not.toMatch(/fabricatedTimeline/i);
    // The page must not hard-code a code snippet pretending to be generated.
    expect(page).not.toMatch(/const\s+demoCode\s*=/);
  });
});

// ===========================================================================
// 7. WorkshopShell — LiquidGlass + lq.* + font-ui; drives real data only
// ===========================================================================
describe('WorkshopShell component', () => {
  const src = read('components/workshop-ai/WorkshopShell.tsx');

  it('uses LiquidGlass + lq tokens + font-ui on the h1', () => {
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/font-ui/);
    expect(src).toMatch(/<h1 className="font-ui/);
    expect(src).toMatch(/text-lq-ink/);
  });

  it('drives the status pill from headerStatusVm (no inline color logic)', () => {
    expect(src).toMatch(/headerStatusVm\(/);
    expect(src).toMatch(/headerMetaVm\(/);
    expect(src).toMatch(/phasesVm\(/);
    expect(src).toMatch(/<JourneyPipelineAi/);
  });

  it('mold badge resolves through the real resolveProjectMold (shows Detecting when unclassified)', () => {
    expect(src).toMatch(/resolveProjectMold\(project,\s*spec\)/);
    expect(src).toMatch(/MOLD_META/);
  });

  it('emits NO fabricated stat strings (tokens, latency, cache %)', () => {
    expect(src).not.toMatch(/tokens?\s*[:=]\s*\d/i);
    expect(src).not.toMatch(/latency\s*[:=]/i);
    expect(src).not.toMatch(/cache\s*hit/i);
  });
});

// ===========================================================================
// 8. JourneyPipelineAi — driven by pipelineDotsVm, single active rim
// ===========================================================================
describe('JourneyPipelineAi component', () => {
  const src = read('components/workshop-ai/JourneyPipelineAi.tsx');

  it('renders dots from pipelineDotsVm (no hard-coded stage array)', () => {
    expect(src).toMatch(/pipelineDotsVm\(journey\)/);
    expect(src).toMatch(/dots\.map/);
    // No hard-coded stages.
    expect(src).not.toMatch(/\[\s*'intent'\s*,\s*'spec'\s*,\s*'plan'\s*,/);
  });

  it('the active rim is the only pulse (gates apply-rim only to d.pulse stages)', () => {
    expect(src).toMatch(/styles\.activeRim/);
    expect(src).toMatch(/d\.pulse \? styles\.activeRim : ''/);
  });
});

// ===========================================================================
// 9. Infinite-animation budget — exactly ONE infinite loop in the module
// ===========================================================================
describe('infinite-animation budget', () => {
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the workshop module has exactly ONE infinite loop (the active rim)', () => {
    expect(countInfinite('components/workshop-ai/workshop.module.css')).toBe(1);
  });

  it('globals.css still ≤4 infinite loops (no workshop keyframes leaked)', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    const css = read('app/globals.css');
    expect(css).not.toMatch(/workshopActiveRim/);
  });
});
