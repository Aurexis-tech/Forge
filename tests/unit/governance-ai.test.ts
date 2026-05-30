// Hermetic tests for the Governance migration. Recomposed to the design-
// study layout (commit ddc47e3 → THIS commit): hero monthly meter +
// secondary daily readout + compact kill-switch + active runtimes (left
// column) + activity stream (right column). The honesty constraints
// stay primary — REAL spend, REAL cap, REAL events, NO looping fake
// values, every real wiring preserved:
//   - spendZone REUSES spendHeatTone's thresholds and remaps to AI colors
//   - the page binds to the real engine APIs (getSpendUsd monthly+daily,
//     listBudgets, activeKillSwitch, agent_runtimes, getRecentCostEvents,
//     audit_log) and never to fabricated arrays
//   - the kill switch wires to /api/governance/killswitch POST/DELETE
//     with the same shapes the forge KillSwitchPanel used
//   - the budget form wires to /api/governance/budget PUT/DELETE
//   - infinite-animation budget stays tight (1 loop in the module — the
//     "Live" pill dot — and ≤4 in globals.css)

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spendHeatTone } from '@/lib/forge-heat';
import {
  auditActorTone,
  costEventTone,
  formatHeroSpend,
  heroMeterTicks,
  KILL_SWITCH_COPY,
  meterFill,
  runtimeMoldColor,
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
    // This proves we did not fork the zone math.
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
// 2. formatHeroSpend + heroMeterTicks — pure hero helpers
// ===========================================================================
describe('formatHeroSpend — dollars + half-size cents split', () => {
  it('splits a real spend into "$X" + ".YY" parts', () => {
    expect(formatHeroSpend(28.4)).toEqual({ dollars: '$28', cents: '.40' });
    expect(formatHeroSpend(0)).toEqual({ dollars: '$0', cents: '.00' });
    expect(formatHeroSpend(1)).toEqual({ dollars: '$1', cents: '.00' });
    expect(formatHeroSpend(99.99)).toEqual({ dollars: '$99', cents: '.99' });
  });
  it('rounds to two-decimal cents (no floating-point lies)', () => {
    expect(formatHeroSpend(0.1 + 0.2)).toEqual({ dollars: '$0', cents: '.30' });
  });
  it('never produces a negative dollar number', () => {
    expect(formatHeroSpend(-5)).toEqual({ dollars: '$0', cents: '.00' });
  });
});

describe('heroMeterTicks — scaled to the real cap', () => {
  it('cap=$100 → $0 / $25 / $50 / $75 / $100 cap', () => {
    expect(heroMeterTicks(100)).toEqual(['$0', '$25', '$50', '$75', '$100 cap']);
  });
  it('cap=$400 → $0 / $100 / $200 / $300 / $400 cap', () => {
    expect(heroMeterTicks(400)).toEqual(['$0', '$100', '$200', '$300', '$400 cap']);
  });
  it('no cap → generic sweep ending in "no cap" (honest)', () => {
    const t = heroMeterTicks(null);
    expect(t[0]).toBe('$0');
    expect(t[t.length - 1]).toBe('no cap');
  });
});

// ===========================================================================
// 3. Kill-switch copy — real action, real prompts
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
// 4. runtimeStatusVm + cost event / audit / mold tones — pure mapping
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

describe('runtimeMoldColor — agent/system/software/infra → AI palette', () => {
  it('agent → aurora, system → violet, software → mint, infrastructure → amber', () => {
    expect(runtimeMoldColor('agent')).toBe('aurora');
    expect(runtimeMoldColor('system')).toBe('violet');
    expect(runtimeMoldColor('software')).toBe('mint');
    expect(runtimeMoldColor('infrastructure')).toBe('amber');
  });
  it('unknown kind → ink-dim (no invented color)', () => {
    expect(runtimeMoldColor('mystery')).toBe('ink-dim');
    expect(runtimeMoldColor(null)).toBe('ink-dim');
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
// 5. /governance is migrated; backdrop switch covers it exactly
// ===========================================================================
describe('/governance is in MIGRATED_ROUTES (exact match)', () => {
  it('contains /governance', () => {
    expect(MIGRATED_ROUTES).toContain('/governance');
    expect(isMigratedRoute('/governance')).toBe(true);
    expect(isMigratedRoute('/governance/extra')).toBe(false);
  });
});

// ===========================================================================
// 6. The route page — binds to REAL engine sources, hands them to GovernanceAi
// ===========================================================================
describe('/governance page wiring', () => {
  const page = read('app/(app)/governance/page.tsx');

  it('renders the GovernanceAi component', () => {
    expect(page).toMatch(/<GovernanceAi /);
    // Forge primitives must NOT leak back in.
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
// 7. GovernanceAi — the design-study LAYOUT + honesty rules
// ===========================================================================
describe('GovernanceAi component', () => {
  const src = read('components/governance-ai/GovernanceAi.tsx');

  it('uses LiquidGlass + lq.* tokens + font-ui on the h1', () => {
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/font-ui/);
    expect(src).toMatch(/<h1 className="font-ui/);
    expect(src).toMatch(/text-lq-ink/);
  });

  it('renders the exact design-study header copy (eyebrow + h1 + sub)', () => {
    expect(src).toContain('Governance · Ceiling + Kill Switch');
    expect(src).toContain('Power, on a leash.');
    expect(src).toMatch(/Every running project/);
    expect(src).toMatch(/Watch it warm in real time/);
    expect(src).toMatch(/Pull the lever/);
  });

  it('arranges a two-column grid (left 1.45fr / right 1fr)', () => {
    expect(src).toMatch(/grid-cols-\[1\.45fr_1fr\]/);
  });

  it('the LEFT column mounts hero + daily + kill switch + runtimes', () => {
    expect(src).toMatch(/<HeroSpendMeterAi/);
    expect(src).toMatch(/<DailySpendReadout/);
    expect(src).toMatch(/<KillSwitchAi/);
    expect(src).toMatch(/<ActiveRuntimesList/);
  });

  it('the RIGHT column mounts the activity stream', () => {
    expect(src).toMatch(/<ActivityStream/);
  });

  it('the hero meter is fed by the REAL monthly spend + monthly cap', () => {
    expect(src).toMatch(/spendUsd=\{data\.monthly\.spendUsd\}/);
    expect(src).toMatch(/budget=\{data\.monthly\.budget\}/);
  });

  it('drives spend zones from the spendZone helper (NOT inline thresholds)', () => {
    expect(src).toMatch(/spendZone\(/);
    expect(src).toMatch(/meterFill\(/);
    expect(src).not.toMatch(/pct\s*>=\s*80/);
    expect(src).not.toMatch(/pct\s*>=\s*50/);
  });

  it('drives mold-badge colors from runtimeMoldColor (real kinds only)', () => {
    expect(src).toMatch(/runtimeMoldColor/);
  });

  it('emits NO fabricated activity (no sparklines, no fake counts, no looping fake spend)', () => {
    expect(src).not.toMatch(/sparkline/i);
    expect(src).not.toMatch(/calls?\s+today/i);
    expect(src).not.toMatch(/tokens?\s+last\s+hour/i);
    expect(src).not.toMatch(/animation:\s*spend/i);
    // The kill switch sub-line MUST NOT lie with "never" when the loader
    // doesn't surface historical engagements.
    expect(src).not.toMatch(/last pulled.*never/i);
  });

  it('emits the empty-state copy for runtimes + activity (true today)', () => {
    expect(src).toMatch(/No active runtimes yet/);
    expect(src).toMatch(/No activity yet/);
  });

  it('runtimes list omits Pause / configure buttons (those actions do not exist)', () => {
    expect(src).not.toMatch(/Pause/);
    expect(src).not.toMatch(/configure\s*runtime/i);
    // The gear / settings glyph would be the design-study's hint at a
    // non-existent action — make sure it isn't there.
    expect(src).not.toMatch(/⚙|svg[^>]*cog|svg[^>]*gear/i);
  });

  it('iterates real runtimes + real merged stream from real events + audit', () => {
    expect(src).toMatch(/data\.activeRuntimes/);
    expect(src).toMatch(/data\.events/);
    expect(src).toMatch(/data\.audit/);
    expect(src).toMatch(/buildStreamRows/);
  });
});

// ===========================================================================
// 8. HeroSpendMeterAi — the centerpiece (real-only fields)
// ===========================================================================
describe('HeroSpendMeterAi component', () => {
  const src = read('components/governance-ai/HeroSpendMeterAi.tsx');

  it('uses LiquidGlass + font-ui on the big number', () => {
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/font-ui/);
  });

  it('drives the badge + glow + ticks + dollars/cents split from pure helpers', () => {
    expect(src).toMatch(/spendZone\(/);
    expect(src).toMatch(/meterFill\(/);
    expect(src).toMatch(/formatHeroSpend\(/);
    expect(src).toMatch(/heroMeterTicks\(/);
  });

  it('reads the REAL cap from budget.limit_usd — never a hard-coded number', () => {
    expect(src).toMatch(/Number\(budget\.limit_usd\)/);
    expect(src).not.toMatch(/const\s+limitUsd\s*=\s*\d/);
  });

  it('the meter fill is the SPECTRUM gradient + a one-shot WIDTH style — not an infinite loop', () => {
    expect(src).toMatch(/meterFillSpectrum/);
    expect(src).toMatch(/style=\{\{ width: fillPct \+ '%' \}\}/);
    expect(src).not.toMatch(/animation:/);
  });

  it('renders the honest "no cap set — every dollar allowed through" copy when capless', () => {
    expect(src).toContain('no cap set — every dollar allowed through');
  });

  it('mounts the BudgetFormAi for the monthly period (the edit-cap affordance)', () => {
    expect(src).toMatch(/<BudgetFormAi[\s\S]*?period="monthly"/);
  });
});

// ===========================================================================
// 9. KillSwitchAi — preserves the REAL POST/DELETE wiring
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

  it('renders the compact panel + the power glyph + the real engaged state', () => {
    expect(src).toMatch(/Kill switch/);
    expect(src).toMatch(/freezes every running project instantly/);
    // The "last pulled" sub-line is the real engagedAt or the honest
    // "currently standby" — never a fabricated "never".
    expect(src).toMatch(/engagedAtIso/);
    expect(src).not.toMatch(/last pulled.*never/i);
  });
});

// ===========================================================================
// 10. BudgetFormAi — preserves the REAL PUT/DELETE wiring
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

  it('is a compact edit-cap toggle (idle button → inline form)', () => {
    expect(src).toMatch(/setEditing\(true\)/);
    expect(src).toMatch(/edit cap|set cap/);
  });

  it('reuses the existing CurrencyPicker (preserves multi-currency wiring)', () => {
    expect(src).toMatch(/from '@\/components\/governance\/CurrencyPicker'/);
  });
});

// ===========================================================================
// 11. Infinite-animation budget — the meter is a BOUNDED transition
// ===========================================================================
describe('infinite-animation budget', () => {
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the governance module has exactly ONE infinite loop (the live-pulse dot)', () => {
    // The bar fill + zone glow are bounded transitions. The single loop
    // is the gentle opacity breathe on the Live pill dot under Active
    // runtimes — documented in the module header.
    expect(countInfinite('components/governance-ai/governance.module.css')).toBe(1);
  });

  it('globals.css still ≤4 infinite loops (no governance keyframes leaked)', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    const css = read('app/globals.css');
    expect(css).not.toMatch(/\.meterFill[A-Z]/);
    expect(css).not.toMatch(/\.zoneGlow[A-Z]/);
    expect(css).not.toMatch(/governanceLivePulse/);
  });

  it('the meter fill is a one-shot CSS transition, not an infinite animation', () => {
    const css = read('components/governance-ai/governance.module.css');
    expect(css).toMatch(/transition:\s*width/);
    // The fill class itself has no animation rule (the only @keyframes
    // is the live-pulse dot — checked above).
    expect(css).toMatch(/\.meterFill\s*\{[^}]*transition:\s*width/);
  });
});
