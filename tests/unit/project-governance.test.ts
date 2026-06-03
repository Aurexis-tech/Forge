// Hermetic tests for the per-project Governance view. node-only:
// pure-VM logic + source/honesty guards. The central rule: this surface
// shows ONLY real signals (spend, gate/authorization decisions, activity,
// runtime status) and an HONEST EMPTY STATE for the un-plumbed runtime
// action feed. A governance surface that fakes actions or offers controls
// that gate nothing is a FALSE SAFETY CLAIM — these tests forbid that.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  activityVm,
  authorizationHistoryVm,
  authorizationLabel,
  AUTHORIZATION_ACTIONS,
  governanceStatsVm,
  isAuthorizationAction,
  RUNTIME_MONITORING_COPY,
} from '@/lib/project-governance';
import type { AuditLog } from '@/lib/types';

const read = (p: string) => readFileSync(p, 'utf8');

const auditRow = (over: Partial<AuditLog>): AuditLog => ({
  id: over.id ?? 'a1',
  project_id: over.project_id ?? 'p1',
  action: over.action ?? 'noop',
  actor: over.actor ?? 'user',
  detail: over.detail ?? {},
  created_at: over.created_at ?? '2026-06-01T10:00:00.000Z',
});

// ===========================================================================
// 1. Authorization action set — the closed vocabulary of real gate decisions
// ===========================================================================
describe('AUTHORIZATION_ACTIONS — closed set of real gate decisions', () => {
  it('matches the engine\'s real authorization audit actions', () => {
    // Every entry must be a real "*_authorized" / "*plan_approved" /
    // killswitch action the engine writes — no invented governance verbs.
    for (const a of AUTHORIZATION_ACTIONS) {
      expect(
        /[._]authorized$|plan[._]approved$|^killswitch\./.test(a),
        a,
      ).toBe(true);
    }
    // The repo + deploy gates the brief calls out are present.
    expect(AUTHORIZATION_ACTIONS).toContain('repo.create_authorized');
    expect(AUTHORIZATION_ACTIONS).toContain('deploy.authorized');
  });

  it('isAuthorizationAction is true only for the set', () => {
    expect(isAuthorizationAction('repo.create_authorized')).toBe(true);
    expect(isAuthorizationAction('killswitch.activated')).toBe(true);
    // Real activity that is NOT an authorization:
    expect(isAuthorizationAction('build.codegen_started')).toBe(false);
    expect(isAuthorizationAction('spec.extracted')).toBe(false);
  });

  it('every action has a human label (no raw fallthrough for known actions)', () => {
    for (const a of AUTHORIZATION_ACTIONS) {
      expect(authorizationLabel(a)).not.toBe(a);
      expect(authorizationLabel(a).length).toBeGreaterThan(3);
    }
  });
});

// ===========================================================================
// 2. authorizationHistoryVm — real gate decisions only, newest first
// ===========================================================================
describe('authorizationHistoryVm', () => {
  const rows: AuditLog[] = [
    auditRow({ id: 'r1', action: 'repo.create_authorized', actor: 'user', created_at: '2026-06-01T10:00:00Z' }),
    auditRow({ id: 'r2', action: 'build.codegen_started', actor: 'engine.codegen', created_at: '2026-06-01T11:00:00Z' }),
    auditRow({ id: 'r3', action: 'deploy.authorized', actor: 'user', created_at: '2026-06-01T12:00:00Z' }),
    auditRow({ id: 'r4', action: 'killswitch.activated', actor: 'engine.governance', created_at: '2026-06-01T13:00:00Z' }),
  ];

  it('keeps ONLY authorization rows (drops non-gate activity)', () => {
    const vm = authorizationHistoryVm(rows);
    expect(vm.map((e) => e.action).sort()).toEqual([
      'deploy.authorized',
      'killswitch.activated',
      'repo.create_authorized',
    ]);
    // The codegen activity row is NOT an authorization.
    expect(vm.find((e) => e.action === 'build.codegen_started')).toBeUndefined();
  });

  it('is newest-first and carries label + actor + tone', () => {
    const vm = authorizationHistoryVm(rows);
    expect(vm[0]!.action).toBe('killswitch.activated'); // 13:00 newest
    expect(vm[0]!.tone).toBe('halt'); // engaging the kill switch is a halt
    const repo = vm.find((e) => e.action === 'repo.create_authorized')!;
    expect(repo.label).toMatch(/repository authorized/i);
    expect(repo.tone).toBe('approved');
    expect(repo.actor).toBe('user');
  });

  it('empty input → empty history (honest empty state upstream)', () => {
    expect(authorizationHistoryVm([])).toEqual([]);
  });
});

// ===========================================================================
// 3. activityVm + governanceStatsVm — real sources, honest absence
// ===========================================================================
describe('activityVm + governanceStatsVm', () => {
  const rows: AuditLog[] = [
    auditRow({ id: 'r1', action: 'repo.create_authorized', actor: 'user', created_at: '2026-06-01T10:00:00Z' }),
    auditRow({ id: 'r2', action: 'build.codegen_started', actor: 'engine.codegen', created_at: '2026-06-01T11:00:00Z' }),
  ];

  it('activityVm includes ALL rows (the honest Activity Logs), newest first', () => {
    const vm = activityVm(rows);
    expect(vm).toHaveLength(2);
    expect(vm[0]!.action).toBe('build.codegen_started'); // 11:00 newest
  });

  it('stats: real spend + gate-decision count; runtime present', () => {
    const s = governanceStatsVm({
      spendUsd: 1.2345,
      auditRows: rows,
      runtimeStatus: 'active',
    });
    expect(s.spendUsd).toBeCloseTo(1.2345);
    expect(s.gateDecisions).toBe(1); // only repo.create_authorized
    expect(s.runtime).toEqual({ label: 'active', live: true });
  });

  it('stats: runtime is NULL when the project has no runtime row (rendered as "—")', () => {
    const s = governanceStatsVm({ spendUsd: 0, auditRows: [], runtimeStatus: null });
    expect(s.runtime).toBeNull();
    expect(s.gateDecisions).toBe(0);
    expect(s.spendUsd).toBe(0);
  });

  it('stats: non-finite spend coerces to 0 (never NaN in the UI)', () => {
    const s = governanceStatsVm({ spendUsd: NaN, auditRows: [], runtimeStatus: null });
    expect(s.spendUsd).toBe(0);
  });
});

// ===========================================================================
// 4. HONESTY GUARDS — the component fakes nothing
// ===========================================================================
describe('ProjectGovernancePanel — honesty guards (source)', () => {
  const src = read('components/governance-ai/ProjectGovernancePanel.tsx');

  it('renders NO hardcoded / fabricated action feed', () => {
    // None of the design-study sample rows may appear anywhere in source.
    expect(src).not.toMatch(/FinanceAI/i);
    expect(src).not.toMatch(/payment[-\s]?batch/i);
    expect(src).not.toMatch(/\$?245[,.]?000/);
    expect(src).not.toMatch(/High Risk/i);
    expect(src).not.toMatch(/Actions Today/i);
    // No hardcoded sample-row array literal pretending to be a feed.
    expect(src).not.toMatch(/const\s+(sample|fake|demo|mock)\w*\s*=/i);
  });

  it('the runtime-monitoring panel shows the honest empty-state copy', () => {
    expect(src).toMatch(/RUNTIME_MONITORING_COPY/);
    // The exact promise is single-sourced — assert the copy itself here.
    expect(RUNTIME_MONITORING_COPY.body).toBe(
      'Runtime action monitoring activates once this project is deployed ' +
        'and reporting its actions. Not available yet.',
    );
  });

  it('the runtime panel offers NO Approve / Block controls (gate nothing → exist not)', () => {
    // No control labels, and the component is non-interactive (server
    // component — no onClick handlers wired to phantom gating).
    expect(src).not.toMatch(/\bApprove\b/);
    expect(src).not.toMatch(/\bBlock\b/);
    expect(src).not.toMatch(/onClick/);
    expect(src).not.toMatch(/^'use client'/m);
  });

  it('binds the real panels to their real sources (no invented data)', () => {
    expect(src).toMatch(/authorizationHistoryVm/);
    expect(src).toMatch(/activityVm/);
    expect(src).toMatch(/governanceStatsVm/);
    expect(src).toMatch(/spendZone/);
    // The props it renders from are the real loaded data.
    expect(src).toMatch(/auditRows/);
    expect(src).toMatch(/spendUsd/);
    expect(src).toMatch(/runtimeStatus/);
  });

  it('renders honest empty states for the real panels when sources are empty', () => {
    expect(src).toMatch(/No authorizations yet/);
    expect(src).toMatch(/No activity logged yet/);
  });

  it('uses the migrated aesthetic (LiquidGlass + lq tokens + font-ui heading)', () => {
    expect(src).toMatch(/LiquidGlass/);
    expect(src).toMatch(/font-ui/);
    expect(src).toMatch(/text-lq-ink/);
    expect(src).toMatch(/<h2 className="font-ui/);
  });
});

// ===========================================================================
// 5. Page wiring — the page loads real audit_log + mounts the panel
// ===========================================================================
describe('/projects/[id] mounts the Governance panel from real data', () => {
  const page = read('app/(app)/projects/[id]/page.tsx');

  it('imports + mounts ProjectGovernancePanel via the governance loader', () => {
    expect(page).toMatch(/import \{ ProjectGovernancePanel \}/);
    expect(page).toMatch(/renderProjectGovernance\(/);
  });

  it('loads the project\'s REAL audit_log rows and passes real spend + runtime', () => {
    expect(page).toMatch(/\.from\('audit_log'\)/);
    expect(page).toMatch(/\.eq\('project_id', args\.project\.id\)/);
    // Spend reuses the already-loaded getProjectSpend value; runtime status
    // comes from the real agent_runtimes row (or null).
    expect(page).toMatch(/spendUsd:\s*costToDateUsd/);
    expect(page).toMatch(/runtimeStatus:\s*runtime\?\.status\s*\?\?\s*null/);
  });
});
