// CRUD-resource composite slot — the deterministic, owner-scoped layer.
//
// Hermetic, no LLM: exercises the pure composite expander, its planner
// integration, the STRUCTURAL owner-scoping (migration owner_id + RLS),
// and the cross-user RLS isolation harness wiring (incl. the new
// update/delete write-isolation probes). The LLM only ever fills
// field-specific route/page content within the vetted families — proven
// separately in the codegen dry-run.

import { describe, expect, it } from 'vitest';
import {
  expandCrudResource,
  crudResourcePages,
  crudResourcePageId,
  CRUD_ROUTE_KINDS,
} from '@/lib/engine/software/codegen/crud-resource';
import { deriveSoftwareGraph } from '@/lib/engine/software/planner/graph';
import { emitSoftwareMigration } from '@/lib/engine/software/codegen/migration';
import {
  entitiesToIsolate,
  planIsolationTest,
  parseIsolationResult,
} from '@/lib/engine/software/sandbox/isolation';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOTE = {
  name: 'Note',
  fields: [
    { name: 'title', type: 'string' },
    { name: 'done', type: 'boolean' },
  ],
} as const;

function crudSpec(over: Partial<SoftwareSpec> = {}): SoftwareSpec {
  return SoftwareSpecSchema.parse({
    goal: 'A personal notes app.',
    pages: [{ id: 'dashboard', name: 'Dashboard', purpose: 'overview' }],
    entities: [
      { name: 'Note', fields: [{ name: 'title', type: 'string' }, { name: 'done', type: 'boolean' }] },
      { name: 'Tag', fields: [{ name: 'label', type: 'string' }] },
    ],
    flows: [],
    auth: { requires_auth: true, per_user_isolation: true },
    crud_resources: ['Note'],
    ...over,
  });
}

// ===========================================================================
// COMPOSITE EXPANSION
// ===========================================================================
describe('expandCrudResource — deterministic atomic-slot set', () => {
  it('expands into 1 owner-scoped table (+RLS) + 5 owner-scoped routes + 1 page', () => {
    const exp = expandCrudResource(NOTE, { perUserIsolation: true });

    // SCHEMA — owner-scoped table + RLS.
    expect(exp.table).toBe('note');
    expect(exp.schema.migration.kind).toBe('entity_migration');
    expect(exp.schema.migration.ownerScoped).toBe(true);
    expect(exp.schema.rls).not.toBeNull();
    expect(exp.schema.rls?.kind).toBe('rls_policy');
    expect(exp.schema.rls?.ownerScoped).toBe(true);

    // ROUTES — exactly the 5 CRUD methods, owner-scoped, correct verbs.
    expect(exp.routes).toHaveLength(5);
    expect(exp.routes.map((r) => r.kind)).toEqual([
      'create_route',
      'list_route',
      'get_route',
      'update_route',
      'delete_route',
    ]);
    expect(exp.routes.map((r) => r.method)).toEqual([
      'POST',
      'GET',
      'GET',
      'PATCH',
      'DELETE',
    ]);
    expect(exp.routes.every((r) => r.ownerScoped)).toBe(true);
    // Collection methods at /api/note; item methods at /api/note/[id].
    const byKind = Object.fromEntries(exp.routes.map((r) => [r.kind, r.path]));
    expect(byKind.create_route).toBe('app/api/note/_create.ts');
    expect(byKind.list_route).toBe('app/api/note/_list.ts');
    expect(byKind.get_route).toBe('app/api/note/[id]/_get.ts');
    expect(byKind.update_route).toBe('app/api/note/[id]/_update.ts');
    expect(byKind.delete_route).toBe('app/api/note/[id]/_delete.ts');

    // PAGE — server-component list + detail view.
    expect(exp.page.kind).toBe('page_component');
    expect(exp.page.layer).toBe('ui');
    expect(exp.page.ownerScoped).toBe(true);
    expect(exp.page.target).toBe('note');
    expect(exp.page.path).toBe('app/(app)/note/page.tsx');
  });

  it('is deterministic — same resource produces the same expansion', () => {
    const a = expandCrudResource(NOTE, { perUserIsolation: true });
    const b = expandCrudResource(NOTE, { perUserIsolation: true });
    expect(a).toEqual(b);
  });

  it('CRUD_ROUTE_KINDS is the canonical 5-method set', () => {
    expect([...CRUD_ROUTE_KINDS]).toEqual([
      'create_route',
      'list_route',
      'get_route',
      'update_route',
      'delete_route',
    ]);
  });

  it('crudResourcePages derives one synthesized page per crud resource', () => {
    const pages = crudResourcePages(crudSpec());
    expect(pages).toHaveLength(1);
    expect(pages[0]!.id).toBe('note');
    expect(pages[0]!.id).toBe(crudResourcePageId('Note'));
    expect(pages[0]!.purpose.toLowerCase()).toContain('owner-scoped');
  });
});

// ===========================================================================
// PLANNER INTEGRATION
// ===========================================================================
describe('deriveSoftwareGraph — CRUD-resource expansion', () => {
  it('a crud entity gets ALL 5 routes + a synthesized page', () => {
    const g = deriveSoftwareGraph(crudSpec());
    const noteRoutes = g.tasks
      .filter((t) => t.layer === 'api' && t.slot.target === 'Note')
      .map((t) => t.slot.kind)
      .sort();
    expect(noteRoutes).toEqual([
      'create_route',
      'delete_route',
      'get_route',
      'list_route',
      'update_route',
    ]);
    // The synthesized resource page.
    const page = g.tasks.find(
      (t) => t.slot.kind === 'page_component' && t.slot.target === 'note',
    );
    expect(page).toBeDefined();
    expect(page!.id).toBe('page_note');
    // Page depends on the resource's routes.
    expect(page!.depends_on.some((d) => d.startsWith('api_'))).toBe(true);
    // Schema migration + RLS for the resource still present (structural).
    expect(g.tasks.some((t) => t.slot.kind === 'entity_migration' && t.slot.target === 'Note')).toBe(true);
    expect(g.tasks.some((t) => t.slot.kind === 'rls_policy' && t.slot.target === 'Note')).toBe(true);
  });

  it('a NON-crud entity in the same spec keeps the conditional derivation (no get_route)', () => {
    const g = deriveSoftwareGraph(crudSpec());
    const tagRoutes = g.tasks.filter(
      (t) => t.layer === 'api' && t.slot.target === 'Tag',
    );
    // Tag (not a crud resource) gets list + create only — and crucially
    // NO get_route (get-by-id is composite-only).
    expect(tagRoutes.some((t) => t.slot.kind === 'get_route')).toBe(false);
    expect(tagRoutes.some((t) => t.slot.kind === 'list_route')).toBe(true);
    expect(tagRoutes.some((t) => t.slot.kind === 'create_route')).toBe(true);
  });

  it('is deterministic — same spec produces the same task set', () => {
    expect(deriveSoftwareGraph(crudSpec())).toEqual(deriveSoftwareGraph(crudSpec()));
  });

  it('BACKWARD COMPAT: a spec with NO crud_resources emits no get_route at all', () => {
    const spec = SoftwareSpecSchema.parse({
      goal: 'plain app',
      pages: [{ id: 'home', name: 'Home', purpose: 'home' }],
      entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
      flows: [],
      auth: { requires_auth: true, per_user_isolation: true },
    });
    const g = deriveSoftwareGraph(spec);
    expect(g.tasks.some((t) => t.slot.kind === 'get_route')).toBe(false);
  });
});

// ===========================================================================
// STRUCTURAL OWNER-SCOPING (schema) — not LLM freehand
// ===========================================================================
describe('CRUD-resource schema is owner-scoped (structural)', () => {
  it('the migration emits owner_id + a per-user RLS policy for the resource', () => {
    const sql = emitSoftwareMigration(crudSpec());
    expect(sql).toContain('alter table public.note enable row level security;');
    expect(sql).toContain('owner_id uuid not null references auth.users(id)');
    expect(sql).toContain('create policy note_owner on public.note');
    expect(sql).toContain('owner_id = auth.uid()');
  });
});

// ===========================================================================
// CROSS-USER RLS ISOLATION — preserved for the new resource
// ===========================================================================
describe('RLS isolation harness covers the CRUD-resource', () => {
  it('the resource table is in the set of tables to isolate', () => {
    expect(entitiesToIsolate(crudSpec())).toContain('note');
  });

  it('the isolation driver probes READ + UPDATE + DELETE as user B', () => {
    const plan = planIsolationTest({ spec: crudSpec() });
    expect(plan.expectedTables).toContain('note');
    const d = plan.driverContent;
    // READ probe (existing).
    expect(d).toContain('where owner_id = $1');
    // WRITE-isolation probes (new): B must not update/delete A's rows.
    expect(d).toContain('set created_at = now() where owner_id = $1 returning id');
    expect(d).toContain('delete from');
    expect(d).toContain('returning id');
    expect(d).toContain('b_updated_a');
    expect(d).toContain('b_deleted_a');
  });

  it('parses a clean run (B sees/updates/deletes 0 of A) as PASSED', () => {
    const out = parseIsolationResult(
      '[isolation] passed {"entities":["note"],"a_wrote":{"note":1},"b_saw_a":{"note":0},"b_updated_a":{"note":0},"b_deleted_a":{"note":0}}\n',
    );
    expect(out.outcome).toBe('passed');
    expect(out.leakCount).toBe(0);
  });

  it('parses an UPDATE/DELETE leak as FAILED (write-isolation violation)', () => {
    const out = parseIsolationResult(
      '[isolation] failed {"entities":["note"],"a_wrote":{"note":1},"b_saw_a":{"note":0},' +
        '"b_updated_a":{"note":1},"b_deleted_a":{"note":0},"leak_count":1,"first_leak_table":"note",' +
        '"reason":"B accessed 1 of A\'s owner-scoped rows (read/update/delete) — RLS leak"}\n',
    );
    expect(out.outcome).toBe('failed');
    expect(out.leakTable).toBe('note');
    expect(out.leakCount).toBe(1);
  });
});

// ===========================================================================
// SPEC VALIDATION — opt-in guardrails
// ===========================================================================
describe('crud_resources spec validation', () => {
  it('accepts a valid owner-scoped crud_resources list', () => {
    expect(() => crudSpec()).not.toThrow();
  });

  it('rejects a crud_resources entry that is not a declared entity', () => {
    expect(() => crudSpec({ crud_resources: ['Ghost'] })).toThrow();
  });

  it('rejects crud_resources when per_user_isolation is off (owner-scoping required)', () => {
    expect(() =>
      crudSpec({ auth: { requires_auth: true, per_user_isolation: false } }),
    ).toThrow();
  });

  it('rejects a crud_resources entity whose synthesized page id collides with a declared page', () => {
    expect(() =>
      crudSpec({
        // 'Note' -> synthesized page id 'note'; declaring a page 'note' collides.
        pages: [{ id: 'note', name: 'Note page', purpose: 'collide' }],
      }),
    ).toThrow();
  });
});
