// Unit test: Phase 3 software build-plan graph derivation + reused
// Phase 1 cycle check.
//
// `deriveSoftwareGraph` maps a SoftwareSpec onto the vetted template:
//   - one entity_migration per entity (+ rls_policy when isolation on)
//   - default list+create API routes per entity; update/delete only
//     when the spec's flow text implies them
//   - one page_component per page (depends on the right API routes)
//   - auth wiring: session_middleware always, role_gate when roles,
//     per_user_isolation_check when isolation is on
//
// The deterministic mapping has no LLM dependency; these tests cover
// the pure-logic side. The LLM detail pass is exercised separately
// in tests/e2e/software-dryrun.test.ts.

import { describe, expect, it } from 'vitest';
import {
  SoftwareGraphError,
  deriveSoftwareGraph,
} from '@/lib/engine/software/planner/graph';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';

function makeSpec(overrides: Partial<SoftwareSpec> = {}): SoftwareSpec {
  const base = SoftwareSpecSchema.parse({
    goal: 'A team expenses tracker with manager approval.',
    pages: [
      { id: 'submit_expense', name: 'Submit', purpose: 'submit a new expense' },
      { id: 'my_history', name: 'My history', purpose: 'see past expenses' },
      { id: 'approvals', name: 'Approvals', purpose: 'manager approves pending expenses' },
    ],
    entities: [
      {
        name: 'Expense',
        fields: [
          { name: 'submitted_by', type: 'reference' },
          { name: 'amount', type: 'number' },
          { name: 'approval_status', type: 'enum' },
        ],
      },
      {
        name: 'User',
        fields: [
          { name: 'email', type: 'email' },
          { name: 'role', type: 'enum' },
        ],
      },
    ],
    flows: [
      {
        name: 'Submit and route to approver',
        description: 'A user submits an expense; manager approves or rejects.',
        pages: ['submit_expense', 'approvals'],
      },
    ],
    auth: { requires_auth: true, roles: ['member', 'manager'], per_user_isolation: true },
  });
  return { ...base, ...overrides } as SoftwareSpec;
}

describe('deriveSoftwareGraph', () => {
  it('produces one migration + one rls task per entity when per_user_isolation=true', () => {
    const spec = makeSpec();
    const g = deriveSoftwareGraph(spec);

    const migrations = g.tasks.filter((t) => t.slot.kind === 'entity_migration');
    expect(migrations.map((t) => t.slot.target).sort()).toEqual(['Expense', 'User']);

    const rls = g.tasks.filter((t) => t.slot.kind === 'rls_policy');
    expect(rls.map((t) => t.slot.target).sort()).toEqual(['Expense', 'User']);

    // Every RLS task depends on its entity's migration.
    for (const r of rls) {
      expect(r.depends_on).toContain('migration_' + (r.slot.target ?? '').toLowerCase());
    }
  });

  it('omits rls tasks when per_user_isolation=false', () => {
    const spec = makeSpec({
      auth: { requires_auth: true, per_user_isolation: false },
    });
    const g = deriveSoftwareGraph(spec);
    expect(g.tasks.some((t) => t.slot.kind === 'rls_policy')).toBe(false);
    // per_user_isolation_check auth task is also omitted.
    expect(
      g.tasks.some((t) => t.slot.kind === 'per_user_isolation_check'),
    ).toBe(false);
  });

  it('emits list + create routes for every entity (always)', () => {
    const spec = makeSpec();
    const g = deriveSoftwareGraph(spec);
    const apiRoutes = g.tasks.filter((t) => t.layer === 'api');
    // Two entities × at least list+create = 4 routes.
    expect(apiRoutes.filter((t) => t.slot.kind === 'list_route')).toHaveLength(2);
    expect(apiRoutes.filter((t) => t.slot.kind === 'create_route')).toHaveLength(2);
  });

  it('adds update routes when the spec\'s flow text implies them', () => {
    const spec = makeSpec(); // canonical flow says "approves or rejects" → implies update
    const g = deriveSoftwareGraph(spec);
    const updates = g.tasks.filter((t) => t.slot.kind === 'update_route');
    // Both entities get an update route because one flow implies update.
    expect(updates.length).toBeGreaterThan(0);
  });

  it('omits update + delete routes when no flow implies them', () => {
    const spec = makeSpec({
      flows: [
        {
          name: 'Submit',
          description: 'a user submits an expense and it shows on their history page.',
          pages: ['submit_expense', 'my_history'],
        },
      ],
    });
    const g = deriveSoftwareGraph(spec);
    expect(g.tasks.some((t) => t.slot.kind === 'update_route')).toBe(false);
    expect(g.tasks.some((t) => t.slot.kind === 'delete_route')).toBe(false);
  });

  it('emits one page_component per page; each depends on relevant API routes', () => {
    const spec = makeSpec();
    const g = deriveSoftwareGraph(spec);
    const pages = g.tasks.filter((t) => t.slot.kind === 'page_component');
    expect(pages).toHaveLength(3);
    for (const p of pages) {
      // Every UI page task depends on at least one api task.
      const apiDeps = p.depends_on.filter((d) => d.startsWith('api_'));
      expect(apiDeps.length).toBeGreaterThan(0);
    }
  });

  it('emits session_middleware + role_gate + per_user_isolation_check when all three apply', () => {
    const spec = makeSpec(); // requires_auth, roles, isolation all on
    const g = deriveSoftwareGraph(spec);
    expect(g.tasks.some((t) => t.slot.kind === 'session_middleware')).toBe(true);
    expect(g.tasks.some((t) => t.slot.kind === 'role_gate')).toBe(true);
    expect(g.tasks.some((t) => t.slot.kind === 'per_user_isolation_check')).toBe(true);
  });

  it('omits auth-layer tasks entirely when requires_auth=false', () => {
    const spec = makeSpec({
      auth: { requires_auth: false, per_user_isolation: false },
    });
    const g = deriveSoftwareGraph(spec);
    expect(g.tasks.some((t) => t.layer === 'auth')).toBe(false);
  });

  it('topological execution order respects all dependencies', () => {
    const spec = makeSpec();
    const g = deriveSoftwareGraph(spec);
    const pos = (id: string) => g.executionOrder.indexOf(id);
    for (const t of g.tasks) {
      for (const dep of t.depends_on) {
        expect(pos(dep)).toBeLessThan(pos(t.id));
      }
    }
    // execution_order is a permutation of task ids.
    expect(g.executionOrder).toHaveLength(g.tasks.length);
    expect(new Set(g.executionOrder).size).toBe(g.tasks.length);
  });

  it('every task ends up in exactly one of the four declared layers', () => {
    const spec = makeSpec();
    const g = deriveSoftwareGraph(spec);
    const layers = new Set(['schema', 'api', 'ui', 'auth']);
    for (const t of g.tasks) {
      expect(layers.has(t.layer)).toBe(true);
    }
  });
});

describe('SoftwareGraphError surface', () => {
  it('exposes the reused Phase 1 DagIssue list for ops debugging', () => {
    // We can't easily produce a cyclic deriveSoftwareGraph output
    // since the mapping is acyclic by construction. But we can confirm
    // the SoftwareGraphError class itself preserves the issues array
    // shape callers depend on.
    const err = new SoftwareGraphError('test', [
      { kind: 'cycle', message: 'simulated' },
    ]);
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]?.kind).toBe('cycle');
    expect(err.name).toBe('SoftwareGraphError');
  });
});
