// ADMIN-DASHBOARD — the structural barriers + composite (no pglite here;
// the policy BEHAVIOUR is proven in software-admin-dashboard-policy.test.ts).
//
// Proves the two INDEPENDENT structural barriers are vetted + read-only +
// sourced from app_metadata:
//   BARRIER 1 — the additive RLS admin-read policy (byte-identical, never LLM,
//     `for select` only, reads app_metadata NOT user_metadata)
//   BARRIER 2 — the server-side guard (reads app_metadata via userHasAnyRole,
//     denies non-admin)
// plus read-only enforcement (no admin write policy), the deferred real-run
// note, the planner page, spec validation, and backward-compat.

import { describe, expect, it } from 'vitest';
import {
  expandAdminDashboard,
  adminViewableEntities,
  adminDashboardPages,
  emitAdminReadPolicy,
  emitAdminGuardFile,
  emitAdminLayoutFile,
  ADMIN_REAL_RUN_NOTE,
} from '@/lib/engine/software/codegen/admin-dashboard';
import { emitSoftwareMigration } from '@/lib/engine/software/codegen/migration';
import { deriveSoftwareGraph } from '@/lib/engine/software/planner/graph';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';

function adminSpec(over: Partial<SoftwareSpec> = {}): SoftwareSpec {
  return SoftwareSpecSchema.parse({
    goal: 'A notes app with an admin dashboard.',
    pages: [{ id: 'dashboard', name: 'Dashboard', purpose: 'overview' }],
    entities: [
      { name: 'Note', fields: [{ name: 'title', type: 'string' }] },
      { name: 'Tag', fields: [{ name: 'label', type: 'string' }] },
    ],
    flows: [],
    auth: { requires_auth: true, per_user_isolation: true },
    admin_dashboard: { entities: ['Note'] },
    ...over,
  });
}

// ===========================================================================
// COMPOSITE
// ===========================================================================
describe('expandAdminDashboard', () => {
  it('expands into per-entity admin-read policies + guard + layout + the LLM view', () => {
    const exp = expandAdminDashboard(adminSpec())!;
    expect(exp).not.toBeNull();
    expect(exp.entities).toEqual(['Note']);
    const kinds = exp.slots.map((s) => s.kind);
    expect(kinds).toEqual([
      'admin_read_policy',
      'admin_guard',
      'admin_layout',
      'admin_view_page',
    ]);
    // Everything structural EXCEPT the view; everything READ-ONLY.
    expect(exp.slots.filter((s) => s.structural).map((s) => s.kind)).toEqual([
      'admin_read_policy',
      'admin_guard',
      'admin_layout',
    ]);
    expect(exp.slots.find((s) => s.kind === 'admin_view_page')!.structural).toBe(false);
    expect(exp.slots.every((s) => s.readOnly)).toBe(true);
    expect(exp.page.id).toBe('admin');
  });

  it('is null when admin_dashboard is absent', () => {
    const spec = SoftwareSpecSchema.parse({
      goal: 'plain',
      pages: [{ id: 'home', name: 'Home', purpose: 'home' }],
      entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
      flows: [],
      auth: { requires_auth: true, per_user_isolation: true },
    });
    expect(expandAdminDashboard(spec)).toBeNull();
  });

  it('adminViewableEntities filters to declared entities', () => {
    expect(adminViewableEntities(adminSpec())).toEqual(['Note']);
  });
});

// ===========================================================================
// BARRIER 1 — RLS admin-read policy (app_metadata, read-only, structural)
// ===========================================================================
describe('admin-read RLS policy (barrier 1)', () => {
  it('is the vetted app_metadata SELECT policy — NEVER user_metadata', () => {
    const sql = emitAdminReadPolicy('note');
    expect(sql).toContain('note_admin_read on public.note for select using (');
    expect(sql).toContain("auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'");
    // The escalation vector is excluded: the policy's JWT access targets
    // app_metadata, NEVER the user-editable user_metadata. (The comment may
    // mention user_metadata to document the boundary; the CLAUSE must not
    // read it.)
    expect(sql).not.toContain("auth.jwt() -> 'user_metadata'");
  });

  it('is byte-identical regardless of anything external', () => {
    expect(emitAdminReadPolicy('note')).toBe(emitAdminReadPolicy('note'));
  });

  it('the migration emits the admin-read policy ALONGSIDE the untouched owner policy', () => {
    const sql = emitSoftwareMigration(adminSpec());
    // Owner policy still there (non-admins stay scoped).
    expect(sql).toContain('create policy note_owner on public.note for all using (owner_id = auth.uid())');
    // Additive admin-read policy.
    expect(sql).toContain('note_admin_read on public.note for select using');
    // Only the admin-viewable entity gets it — Tag does NOT.
    expect(sql).not.toContain('tag_admin_read');
  });

  it('READ-ONLY: the migration emits NO admin write policy (no insert/update/delete/all for admin)', () => {
    const sql = emitSoftwareMigration(adminSpec());
    // The only admin policy is `_admin_read ... for select`. No admin write.
    expect(sql).not.toContain('admin_read on public.note for insert');
    expect(sql).not.toContain('admin_read on public.note for update');
    expect(sql).not.toContain('admin_read on public.note for delete');
    expect(sql).not.toContain('admin_read on public.note for all');
    // No separate admin write policy under any other name either.
    expect(sql).not.toMatch(/note_admin_(write|all|insert|update|delete)\b/);
  });
});

// ===========================================================================
// BARRIER 2 — server-side guard (app_metadata, denies non-admin, structural)
// ===========================================================================
describe('server-side admin guard (barrier 2)', () => {
  it('checks the admin role server-side via userHasAnyRole (app_metadata) + redirects non-admins', () => {
    const guard = emitAdminGuardFile();
    expect(guard).toContain("userHasAnyRole(['admin'])");
    expect(guard).toContain("redirect('/')");
    // The guard delegates the role read to userHasAnyRole (which reads
    // app_metadata in the scaffold's roles.ts) — it never reads metadata
    // directly, so there is no user_metadata property access here.
    expect(guard).not.toContain('user_metadata.role');
    expect(guard).not.toContain("['user_metadata']");
    // Documents the deferred real-run check (not a silent gap).
    expect(guard).toContain('DEFERRED real-run check');
    expect(ADMIN_REAL_RUN_NOTE.length).toBeGreaterThan(0);
  });

  it('the guard layout calls requireAdmin() before rendering children', () => {
    const layout = emitAdminLayoutFile();
    expect(layout).toContain("import { requireAdmin } from '@/lib/auth/admin'");
    expect(layout).toContain('await requireAdmin()');
  });
});

// ===========================================================================
// PLANNER + BACKWARD COMPAT
// ===========================================================================
describe('planner emits the admin view page; backward-compat holds', () => {
  it('a page_admin task exists, depending on the viewable entity migration', () => {
    const g = deriveSoftwareGraph(adminSpec());
    const page = g.tasks.find(
      (t) => t.slot.kind === 'page_component' && t.slot.target === 'admin',
    );
    expect(page).toBeDefined();
    expect(page!.id).toBe('page_admin');
    expect(page!.depends_on).toContain('migration_note');
    expect(adminDashboardPages(adminSpec())[0]!.id).toBe('admin');
  });

  it('a spec WITHOUT admin_dashboard emits no admin policy + no admin page', () => {
    const spec = SoftwareSpecSchema.parse({
      goal: 'plain',
      pages: [{ id: 'home', name: 'Home', purpose: 'home' }],
      entities: [{ name: 'Note', fields: [{ name: 'title', type: 'string' }] }],
      flows: [],
      auth: { requires_auth: true, per_user_isolation: true },
    });
    expect(emitSoftwareMigration(spec)).not.toContain('admin_read');
    const g = deriveSoftwareGraph(spec);
    expect(g.tasks.some((t) => t.slot.target === 'admin')).toBe(false);
  });
});

// ===========================================================================
// SPEC VALIDATION
// ===========================================================================
describe('admin_dashboard spec validation', () => {
  it('accepts a valid owner-scoped admin_dashboard', () => {
    expect(() => adminSpec()).not.toThrow();
  });

  it('rejects admin_dashboard when per_user_isolation is off', () => {
    expect(() =>
      adminSpec({ auth: { requires_auth: true, per_user_isolation: false } }),
    ).toThrow();
  });

  it('rejects an unknown viewable entity', () => {
    expect(() => adminSpec({ admin_dashboard: { entities: ['Ghost'] } })).toThrow();
  });

  it("rejects a declared page colliding with the synthesized 'admin' page id", () => {
    expect(() =>
      adminSpec({
        pages: [
          { id: 'dashboard', name: 'D', purpose: 'd' },
          { id: 'admin', name: 'A', purpose: 'collide' },
        ],
      }),
    ).toThrow();
  });
});
