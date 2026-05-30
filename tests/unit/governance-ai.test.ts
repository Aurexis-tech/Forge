// Hermetic tests for the Governance migration. The honesty constraints
// (REAL spend, REAL cap, REAL events, NO looping fake values) are encoded
// as assertions: spendZone reuses spendHeatTone's thresholds and remaps to
// AI colors; the meter fill is a BOUNDED CSS transition, never an infinite
// animation; the page binds to the real engine APIs (getSpendUsd,
// getRecentCostEvents, listBudgets, activeKillSwitch, agent_runtimes,
// audit_log) and not to fabricated arrays; the kill switch wires to the
// REAL /api/governance/killswitch endpoint with the same POST/DELETE
// shapes the forge KillSwitchPanel used.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spendHeatTone } from '@/lib/forge-heat';
import {
  auditActorTone,
  costEventTone,
  KILL_SWITCH_COPY,
  meterFill,
  runtimeStatusVm,
  spendZone,
} from '@/lib/governance-zones';
import { isMigratedRoute, MIGRATED_ROUTES } from '@/lib/migrated-routes';

const read = (p: string) => readFileSync(p, 'utf8');

// ===========================================================================
// 1. spendZone — REUSES spendHeatTone's thresholds, remaps to AI colors
// ===========================================================================
describe('spendZone — pure zone mapping', () => {
  it('no cap → "NO CAP SET" mint (own zone — not lying as "under cap")', () => {
    expect(spendZone(0, null).zone).toBe('no-cap');
    expect(spendZone(50, 0).zone).toBe('no-cap');
    expect(spendZone(50, undefined).zone).toBe('no-cap');
    expect(spendZone(50, null).label).toBe('NO CAP SET');
    expect(spendZone(50, null).color).toBe('mint');
  });

  it('cool zone (<50%) → mint "UNDER CAP"', () => {
    expect(spendZone(10, 100).zone).toBe('safe');
    expect(spendZone(49, 100).zone).toBe('safe');
    expect(spendZone(10, 100).color).toBe('mint');
    expect(spendZone(10, 100).label).toBe('UNDER CAP');
  });

  it('ember zone (50–79%) → aurora "STEADY"', () => {
    expect(spendZone(50, 100).zone).toBe('steady');
    expect(spendZone(79, 100).zone).toBe('steady');
    expect(spendZone(50, 100).color).toBe('aurora');
    expect(spendZone(50, 100).label).toBe('STEADY');
  });

  it('glow zone (80–99%) → amber "WARMING"', () => {
    expect(spendZone(80, 100).zone).toBe('warming');
    expect(spendZone(99, 100).zone).toBe('warming');
    expect(spendZone(80, 100).color).toBe('amber');
    expect(spendZone(80, 100).label).toBe('WARMING');
  });

  it('molten zone (≥100%) → rose "AT CAP"', () => {
    expect(spendZone(100, 100).zone).toBe('over');
    expect(spendZone(150, 100).zone).toBe('over');
    expect(spendZone(100, 100).color).toBe('rose');
    expect(spendZone(100, 100).label).toBe('AT CAP');
  });

  it('REUSES spendHeatTone thresholds — every band matches the source', () => {
    // The remap rule: cool→mint, ember→aurora, glow→amber, molten→rose.
    // This proves we did not fork the zone math. `spendHeatTone` returns the
    // wider HeatTone union (the badge's full palette), but for spend it only
    // ever produces these four; the Record is typed loosely so the index is
    // valid for the wider union.
    const expectedColor: Record<string, string> = {
      cool: 'mint',
      ember: 'aurora',
      glow: 'amber',
      molten: 'rose',
    };
    const cap = 100;
    for (let pct = 0; pct <= 150; pct += 5) {
      const tone = spendHeatTone(pct, cap);
      const vm = spendZone(pct, cap);
      expect(vm.color, 'pct=' + pct).toBe(expectedColor[tone]);
    }
  });

  it('headroom line states real remaining dollars + pct', () => {
    const vm = spendZone(40, 100);
    expect(vm.headroom).toMatch(/\$60\.00 headroom/);
    expect(vm.headroom).toMatch(/40% of cap/);
  });
});

describe('meterFill — bounded [0, 1] fraction', () => {
  it('null/zero cap → 0 (nothing to fill against)', () => {
    expect(meterFill(50, null)).toBe(0);
    expect(meterFill(50, 0)).toBe(0);
  });
  it('returns the real fraction in normal range', () => {
    expect(meterFill(25, 100)).toBe(0.25);
    expect(meterFill(80, 100)).toBe(0.8);
  });
  it('clamps to 1 when spend is over the cap (bar never overflows)', () => {
    expect(meterFill(150, 100)).toBe(1);
    expect(meterFill(1000, 100)).toBe(1);
  });
});

// ===========================================================================
// 2. Kill-switch copy — real action, real prompts
// ===========================================================================
describe('KILL_SWITCH_COPY — claims match the real engine action', () => {
  it('the mechanism describes what the real action does (halts scheduler)', () => {
    expect(KILL_SWITCH_COPY.engagedMechanism).toMatch(/halts? the scheduler/i);
    expect(KILL_SWITCH_COPY.engagedMechanism).toMatch(/refuses every new cost/i);
  });
  it('the engaged copy says it pauses everything (not "auto-resumes")', () => {
    expect(KILL_SWITCH_COPY.engagedNow).toMatch(/blocked/i);
    expect(KILL_SWITCH_COPY.engagedNow).not.toMatch(/auto[- ]resume/i);
  });
  it('engage + clear confirms are non-empty (not bypassable accidentally)', () => {
    expect(KILL_SWITCH_COPY.engageConfirm.length).toBeGreaterThan(20);
    expect(KILL_SWITCH_COPY.clearConfirm.length).toBeGreaterThan(20);
  });
});

// ===========================================================================
// 3. runtimeStatusVm + cost event / audit tones — pure mapping
// ===========================================================================
describe('runtimeStatusVm — REAL RuntimeStatus statuses only', () => {
  it('maps active → aurora live, paused → ink-dim, errored → rose, stopped → ink-dim', () => {
    expect(runtimeStatusVm('active')).toEqual({ label: 'active', color: 'aurora', live: true });
    expect(runtimeStatusVm('paused')).toEqual({ label: 'paused', color: 'ink-dim', live: false });
    expect(runtimeStatusVm('errored')).toEqual({ label: 'errored', color: 'rose', live: false });
    expect(runtimeStatusVm('stopped')).toEqual({ label: 'stopped', color: 'ink-dim', live: false });
  });
  it('falls back gracefully on an unknown status (never invents a live signal)', () => {
    expect(runtimeStatusVm('mystery').live).toBe(false);
    expect(runtimeStatusVm('mystery').color).toBe('ink-dim');
  });
});

describe('costEventTone — one AI color per REAL ledger kind', () => {
  it('llm → amber, sandbox → aurora, runtime → mint, unknown → ink-dim', () => {
    expect(costEventTone('llm')).toBe('amber');
    expect(costEventTone('sandbox')).toBe('aurora');
    expect(costEventTone('runtime')).toBe('mint');
    expect(costEventTone('something-else')).toBe('ink-dim');
  });
});

describe('auditActorTone — same actors the engine writes to audit_log', () => {
  it('colors user / engine.* / integration.* distinctly', () => {
    expect(auditActorTone('user')).toBe('amber');
    expect(auditActorTone('engine.governance')).toBe('rose');
    expect(auditActorTone('engine.spec')).toBe('aurora');
    expect(auditActorTone('integration.github')).toBe('mint');
    expect(auditActorTone('whatever')).toBe('ink-dim');
  });
});

// ===========================================================================
// 4. /governance is migrated; backdrop switch covers it exactly
// ===========================================================================
describe('/governance is in MIGRATED_ROUTES (exact match)', () => {
  it('contains /governance', () => {
    expect(MIGRATED_ROUTES).toContain('/governance');
    expect(isMigratedRoute('/governance')).toBe(true);
    expect(isMigratedRoute('/governance/extra')).toBe(false);
  });
});

// ===========================================================================
// 5. The route page — binds to REAL engine sources, hands them to GovernanceAi
// ===========================================================================
describe('/governance page wiring', () => {
  const page = read('app/(app)/governance/page.tsx');

  it('renders the new GovernanceAi component (not the forge primitives)', () => {
    expect(page).toMatch(/<GovernanceAi /);
    expect(page).not.toMatch(/<SectionHeader/);
    expect(page).not.toMatch(/<EmberCard/);
    expect(page).not.toMatch(/<SpendMeter\b/);
    expect(page).not.toMatch(/<KillSwitchPanel\b/);
    expect(page).not.toMatch(/<BudgetForm\b/);
    expect(page).not.toMatch(/<CostEventsTable\b/);
    expect(page).not.toMatch(/<AuditTrail\b/);
  });

  it('still gates on requireUser (same auth)', () => {
    expect(page).toMatch(/requireUser/);
  });

  it('binds spend to the REAL getSpendUsd (both periods)', () => {
    expect(page).toMatch(/getSpendUsd\(userId,\s*'daily'/);
    expect(page).toMatch(/getSpendUsd\(userId,\s*'monthly'/);
    // Not a hard-coded constant.
    expect(page).not.toMatch(/const\s+spendUsd\s*=\s*\d/);
  });

  it('binds the cap to REAL listBudgets (not a hard-coded value)', () => {
    expect(page).toMatch(/listBudgets\(userId/);
    expect(page).not.toMatch(/const\s+capUsd\s*=\s*\d/);
  });

  it('sources events from REAL getRecentCostEvents (not a fabricated array)', () => {
    expect(page).toMatch(/getRecentCostEvents\(userId/);
    // No fake activity drips anywhere on the page.
    expect(page).not.toMatch(/deploy\s+succeeded/i);
    expect(page).not.toMatch(/N\s+calls?\s+today/i);
  });

  it('sources runtimes from REAL agent_runtimes', () => {
    expect(page).toMatch(/from\('agent_runtimes'\)/);
    expect(page).toMatch(/projects\.user_id/);
  });

  it('sources the kill switch from REAL activeKillSwitch', () => {
    expect(page).toMatch(/activeKillSwitch\(\{\s*userId\s*\}/);
  });

  it('sources audit rows from REAL audit_log', () => {
    expect(page).toMatch(/from\('audit_log'\)/);
  });
});

// ===========================================================================
// 6. GovernanceAi — LiquidGlass + lq.* tokens, NO fabricated activity
// ===========================================================================
describe('GovernanceAi component', () => {
  const src = read('components/governance-ai/GovernanceAi.tsx');

  it('uses the AI primitives + tokens + font-ui', () => {
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/font-ui/);
    expect(src).toMatch(/<h1 className="font-ui/);
    expect(src).toMatch(/text-lq-ink/);
  });

  it('drives spend zones from the spendZone helper (NOT inline thresholds)', () => {
    expect(src).toMatch(/spendZone\(/);
    expect(src).toMatch(/meterFill\(/);
    // The component must not re-implement the threshold math.
    expect(src).not.toMatch(/pct\s*>=\s*80/);
    expect(src).not.toMatch(/pct\s*>=\s*50/);
  });

  it('emits NO fabricated activity (no sparklines, no fake call counts, no looping fake spend)', () => {
    expect(src).not.toMatch(/sparkline/i);
    expect(src).not.toMatch(/calls?\s+today/i);
    expect(src).not.toMatch(/tokens?\s+last\s+hour/i);
    // The fill MUST be a CSS transition, not an animation loop.
    expect(src).not.toMatch(/animation:\s*spend/i);
  });

  it('mounts the real kill-switch + budget-form client islands', () => {
    expect(src).toMatch(/<KillSwitchAi/);
    expect(src).toMatch(/<BudgetFormAi/);
  });

  it('iterates real runtimes + real events + real audit (no hard-coded arrays)', () => {
    expect(src).toMatch(/data\.activeRuntimes\.map/);
    expect(src).toMatch(/data\.events\.slice/);
    expect(src).toMatch(/data\.audit\.slice/);
  });
});

// ===========================================================================
// 7. KillSwitchAi — preserves the REAL POST/DELETE wiring
// ===========================================================================
describe('KillSwitchAi client island', () => {
  const src = read('components/governance-ai/KillSwitchAi.tsx');

  it('is a client component on the lq primitives', () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/LiquidGlass/);
  });

  it('PRESERVES the engage POST exactly (same endpoint, same body)', () => {
    expect(src).toMatch(/fetch\('\/api\/governance\/killswitch'/);
    expect(src).toMatch(/method:\s*'POST'/);
    expect(src).toMatch(/scope:\s*'global',\s*reason:\s*'manual'/);
  });

  it('PRESERVES the release DELETE exactly (same endpoint, same body shape)', () => {
    expect(src).toMatch(/method:\s*'DELETE'/);
    expect(src).toMatch(/scope:\s*'global'/);
  });

  it('still confirms before engaging + releasing (real safety prompt, not bypassed)', () => {
    expect(src).toMatch(/confirm\(KILL_SWITCH_COPY\.engageConfirm\)/);
    expect(src).toMatch(/confirm\(KILL_SWITCH_COPY\.clearConfirm\)/);
  });

  it('drives its copy from the single KILL_SWITCH_COPY constant', () => {
    expect(src).toMatch(/KILL_SWITCH_COPY\.eyebrow/);
    expect(src).toMatch(/KILL_SWITCH_COPY\.headline/);
    expect(src).toMatch(/KILL_SWITCH_COPY\.engageCta/);
    expect(src).toMatch(/KILL_SWITCH_COPY\.clearCta/);
  });
});

// ===========================================================================
// 8. BudgetFormAi — preserves the REAL PUT/DELETE wiring
// ===========================================================================
describe('BudgetFormAi client island', () => {
  const src = read('components/governance-ai/BudgetFormAi.tsx');

  it('is a client component on the lq primitives', () => {
    expect(src).toMatch(/^'use client'/m);
    expect(src).toMatch(/LiquidGlass/);
  });

  it('PRESERVES the save PUT exactly (same endpoint, same body shape)', () => {
    expect(src).toMatch(/fetch\('\/api\/governance\/budget'/);
    expect(src).toMatch(/method:\s*'PUT'/);
    expect(src).toMatch(/period,\s*\n\s*amount:/);
    expect(src).toMatch(/currency:\s*ccy\.code/);
    expect(src).toMatch(/hard_cap:\s*true/);
  });

  it('PRESERVES the clear DELETE exactly (same body shape)', () => {
    expect(src).toMatch(/method:\s*'DELETE'/);
    expect(src).toMatch(/JSON\.stringify\(\{\s*period\s*\}/);
  });
});

// ===========================================================================
// 9. Infinite-animation budget — the meter is a BOUNDED transition
// ===========================================================================
describe('infinite-animation budget', () => {
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the governance module has ZERO infinite loops (the meter fill is a CSS transition)', () => {
    expect(countInfinite('components/governance-ai/governance.module.css')).toBe(0);
  });

  it('globals.css still ≤4 infinite loops (no governance keyframes leaked)', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    // The governance CSS module has no @keyframes at all (the meter fill is a
    // CSS transition), so there is literally nothing that could leak — but we
    // still confirm the prefixed local class names don't show up globally.
    const css = read('app/globals.css');
    expect(css).not.toMatch(/\.meterFill[A-Z]/);
    expect(css).not.toMatch(/\.zoneGlow[A-Z]/);
  });

  it('the meter fill is a one-shot CSS transition, not an animation', () => {
    const css = read('components/governance-ai/governance.module.css');
    expect(css).toMatch(/transition:\s*width/);
    expect(css).not.toMatch(/@keyframes/);
  });
});
