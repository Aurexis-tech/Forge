/**
 * forge-gates.test.ts
 * Hermetic guard tests for Capability Upgrade #4 gaps. No real cloud, no money.
 * Each test fails the instant a safety promise is broken — same spirit as the
 * 1500+ existing tests. Written for vitest/jest (describe/it/expect).
 *
 * (Module imports retargeted to the repo's `@/` alias; the modules live under
 * lib/engine/software/gates/. Assertions are unchanged.)
 */
import { describe, expect, it } from 'vitest';
import {
  assertDeployable, evaluateDeployGate, applyDeploy, recordIsolation,
  DeployBlocked, type RunState,
} from '@/lib/engine/software/gates/deploy-gate-isolation';
import {
  buildSchemaDiff, buildDbProvisionPrompt, applyDbProvision, ProvisionBlocked,
} from '@/lib/engine/software/gates/db-provision-schema-diff';

const softwareRun = (over: Partial<RunState> = {}): RunState => ({
  id: 'r1', mold: 'software', buildHash: 'h1', checks: {}, ...over,
});

describe('#4 gap 1 — isolation is a hard, fail-closed deploy blocker', () => {
  it('BLOCKS deploy when isolation result is MISSING (never fail-open)', () => {
    expect(() => assertDeployable(softwareRun())).toThrow(DeployBlocked);
    expect(evaluateDeployGate(softwareRun())).toMatchObject({ state: 'blocked', reason: 'isolation_missing' });
  });

  it('BLOCKS deploy when isolation FAILED', () => {
    const run = softwareRun();
    recordIsolation(run, { status: 'fail', checkedAt: 'now', buildHash: 'h1' });
    expect(evaluateDeployGate(run)).toMatchObject({ state: 'blocked', reason: 'isolation_failed' });
  });

  it('BLOCKS deploy when isolation result is STALE (from an earlier codegen)', () => {
    const run = softwareRun({ buildHash: 'h2' });
    recordIsolation(run, { status: 'pass', checkedAt: 'old', buildHash: 'h1' }); // pass, but old build
    expect(evaluateDeployGate(run)).toMatchObject({ state: 'blocked', reason: 'isolation_stale' });
  });

  it('ALLOWS deploy only when isolation PASSED for the current build', () => {
    const run = softwareRun();
    recordIsolation(run, { status: 'pass', checkedAt: 'now', buildHash: 'h1' });
    expect(evaluateDeployGate(run)).toEqual({ state: 'awaiting_authorization' });
  });

  it('cannot be bypassed by {authorized:true} — applyDeploy RE-ASSERTS', async () => {
    const run = softwareRun(); // no isolation result
    await expect(applyDeploy(run, true, async () => {})).rejects.toThrow(DeployBlocked);
  });

  it('non-software molds skip isolation (no multi-user surface)', () => {
    expect(evaluateDeployGate(softwareRun({ mold: 'agent' }))).toEqual({ state: 'awaiting_authorization' });
  });
});

describe('#4 gap 2 — schema diff is surfaced and destructive ops are double-confirmed', () => {
  const current = [{ name: 'users', columns: [{ name: 'id', type: 'uuid' }, { name: 'email', type: 'text' }] }];

  it('reports creates and additive columns as non-destructive', () => {
    const planned = [
      { name: 'users', columns: [{ name: 'id', type: 'uuid' }, { name: 'email', type: 'text' }, { name: 'name', type: 'text' }] },
      { name: 'expenses', columns: [{ name: 'id', type: 'uuid' }] },
    ];
    const diff = buildSchemaDiff(current, planned);
    expect(diff.createTables.map(t => t.name)).toContain('expenses');
    expect(diff.addColumns).toHaveLength(1);
    expect(diff.destructive).toHaveLength(0);
  });

  it('flags drops and lossy type changes as destructive (fail-closed on ambiguous types)', () => {
    const planned = [{ name: 'users', columns: [{ name: 'id', type: 'int' }] }]; // dropped email, uuid→int
    const diff = buildSchemaDiff(current, planned);
    const kinds = diff.destructive.map(d => d.kind);
    expect(kinds).toContain('drop_column');   // email gone
    expect(kinds).toContain('narrow_type');   // uuid → int is not a known-safe widening
  });

  it('a destructive provision is BLOCKED without the typed confirmation', async () => {
    const planned = [{ name: 'users', columns: [{ name: 'id', type: 'uuid' }] }]; // drops email
    const prompt = buildDbProvisionPrompt(current, planned, 'forge_db');
    expect(prompt.requiresTypedConfirm).toBe(true);
    await expect(applyDbProvision({ prompt, authorized: true, migrate: async () => {} }))
      .rejects.toThrow(ProvisionBlocked);
  });

  it('a destructive provision proceeds only with authorized + correct typed confirm', async () => {
    const planned = [{ name: 'users', columns: [{ name: 'id', type: 'uuid' }] }];
    const prompt = buildDbProvisionPrompt(current, planned, 'forge_db');
    let ran = false;
    await applyDbProvision({ prompt, authorized: true, typedConfirm: 'forge_db', migrate: async () => { ran = true; } });
    expect(ran).toBe(true);
  });

  it('never runs without authorization', async () => {
    const prompt = buildDbProvisionPrompt(current, current, 'forge_db'); // no-op diff
    await expect(applyDbProvision({ prompt, authorized: false, migrate: async () => {} }))
      .rejects.toThrow(ProvisionBlocked);
  });
});
