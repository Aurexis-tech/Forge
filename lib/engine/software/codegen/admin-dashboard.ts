// Aurexis Forge — Phase 3 (Software) ADMIN-DASHBOARD slot.
//
// THE ONE SLOT THAT DELIBERATELY CROSSES OWNER-SCOPING: an admin reads
// rows that aren't theirs. The entire focus is the role gate — a non-admin
// must NEVER see another user's rows. Two INDEPENDENT structural barriers
// protect this, both vetted + NEVER LLM-authored; the admin role is sourced
// ONLY from server-controlled JWT app_metadata (a user cannot self-promote);
// admin access is READ-ONLY (writes stay owner-scoped).
//
// ROLE MECHANISM (server-controlled, never client-trusted):
//   Admin  ==  auth.jwt() -> 'app_metadata' ->> 'role'  ==  'admin'
//   app_metadata is set ONLY via the service-role / admin API (out of band:
//   the app owner promotes a user via the Supabase dashboard). It is NOT
//   user-editable. The policy + guard read app_metadata, NEVER user_metadata
//   (user_metadata IS user-editable → the classic privilege-escalation vuln).
//
// TWO INDEPENDENT STRUCTURAL BARRIERS (defense in depth):
//   BARRIER 1 — RLS admin-read policy: an ADDITIVE `for select` policy per
//     admin-viewable table (emitAdminReadPolicy). Admins SELECT all rows;
//     the owner policy is UNTOUCHED, so non-admins stay scoped to their own
//     rows (the admin clause is false → only the owner clause matches). NO
//     admin write policy — read-only.
//   BARRIER 2 — server-side guard: the /admin segment layout calls
//     requireAdmin() server-side BEFORE any admin page renders; a non-admin
//     is redirected. Reads app_metadata via the scaffold's userHasAnyRole.
//   INDEPENDENT: a guard bug → RLS still scopes non-admins to their own
//   rows; RLS bypassed → the guard denies the route. Neither alone is
//   trusted.
//
// The LLM fills ONLY the admin VIEW UI inside the guarded shell — never the
// policy, the guard, or the metadata source.
//
// TEST BOUNDARY: the policy LOGIC is proven HERMETICALLY (the generated
// migration runs in in-process pglite; the 3 cases — non-admin sees own,
// admin sees all, user_metadata-admin sees own — are asserted directly,
// closing the escalation path). The DEFERRED real-run check is small: that
// real Supabase carries the role in the JWT app_metadata and the server
// session reads it. Documented in-app + asserted by a test, not silent.

import type { SoftwareSpec } from '../spec';

export const ADMIN_ROLE = 'admin';
export const ADMIN_DASHBOARD_PAGE_ID = 'admin';
export const ADMIN_GUARD_PATH = 'lib/auth/admin.ts';
export const ADMIN_LAYOUT_PATH = 'app/(app)/admin/layout.tsx';

// The single source of the role claim — used by BOTH the RLS policy and the
// server-side guard so they can never read different metadata.
export const ADMIN_ROLE_CLAIM_SQL = "auth.jwt() -> 'app_metadata' ->> 'role'";

// Documented deferred real-run check (smaller than file-upload's: the policy
// logic itself is proven hermetically).
export const ADMIN_REAL_RUN_NOTE =
  "DEFERRED real-run check: in production, real Supabase Auth must carry the " +
  "user's role in the JWT app_metadata (set out of band via the service-role / " +
  "Supabase dashboard — NEVER through the app), and the server session must " +
  'read it. The policy + guard LOGIC is proven hermetically (pglite); this ' +
  'plumbing is verified on a real Supabase run.';

// ---------------------------------------------------------------------------
// Mechanical helper — inlined so this module never imports migration.ts
// (migration.ts imports THIS module for the admin policy, one-directional).
// ---------------------------------------------------------------------------
function tableName(name: string): string {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/** Declared entity names the admin dashboard may read across owners. */
export function adminViewableEntities(spec: SoftwareSpec): string[] {
  const declared = new Set(spec.entities.map((e) => e.name));
  return (spec.admin_dashboard?.entities ?? []).filter((n) => declared.has(n));
}

export interface AdminDashboardPageDescriptor {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}

/** Synthesized admin dashboard page descriptor (empty when not opted in). */
export function adminDashboardPages(spec: SoftwareSpec): AdminDashboardPageDescriptor[] {
  if (!spec.admin_dashboard || adminViewableEntities(spec).length === 0) return [];
  const entities = adminViewableEntities(spec);
  return [
    {
      id: ADMIN_DASHBOARD_PAGE_ID,
      name: 'Admin dashboard',
      purpose:
        'ADMIN-ONLY read view across all users\' rows of: ' +
        entities.join(', ') +
        '. Access is gated server-side (admins only) AND by RLS; this view ' +
        'is READ-ONLY (no edits/deletes of other users\' rows).',
    },
  ];
}

// ===========================================================================
// BARRIER 1 — the vetted additive admin-read RLS policy. STRUCTURAL,
// byte-identical, never reaches the LLM. READ-ONLY (`for select` only).
// ===========================================================================
export function emitAdminReadPolicy(table: string): string {
  const lines: string[] = [];
  lines.push(
    '-- ADMIN-READ (additive, read-only). Admins SELECT all rows; the owner',
  );
  lines.push(
    '-- policy above is UNTOUCHED, so non-admins still see only their own.',
  );
  lines.push('-- Role is sourced from server-controlled JWT app_metadata ONLY');
  lines.push('-- (NEVER user_metadata — that is user-editable). No admin write policy.');
  lines.push(
    'drop policy if exists ' + table + '_admin_read on public.' + table + ';',
  );
  lines.push(
    'create policy ' +
      table +
      '_admin_read on public.' +
      table +
      ' for select using (' +
      ADMIN_ROLE_CLAIM_SQL +
      " = '" +
      ADMIN_ROLE +
      "');",
  );
  return lines.join('\n');
}

// ===========================================================================
// BARRIER 2 — the server-side guard + the guarded segment layout. STRUCTURAL,
// never LLM. The guard reads app_metadata via the scaffold's userHasAnyRole.
// ===========================================================================
export function emitAdminGuardFile(): string {
  return [
    '// Aurexis Forge — admin guard (template-emitted, NOT LLM-authored).',
    '//',
    '// BARRIER 2 of two independent structural barriers (barrier 1 is the',
    '// additive RLS admin-read policy). Server-side role check: admin ==',
    "// app_metadata.role === 'admin'. The role comes from SERVER-CONTROLLED",
    '// JWT app_metadata (set out of band via the service-role / Supabase',
    '// dashboard) — a user CANNOT self-promote. userHasAnyRole reads',
    '// app_metadata, NEVER user_metadata (user-editable → escalation vuln).',
    '//',
    '// ' + ADMIN_REAL_RUN_NOTE,
    "import { redirect } from 'next/navigation';",
    "import { userHasAnyRole } from '@/lib/auth/roles';",
    '',
    '// Call at the top of any admin-only server component / route. Non-admins',
    '// are redirected to the app root before any admin data is queried.',
    'export async function requireAdmin(): Promise<void> {',
    "  const isAdmin = await userHasAnyRole(['" + ADMIN_ROLE + "']);",
    '  if (!isAdmin) {',
    "    redirect('/');",
    '  }',
    '}',
    '',
  ].join('\n');
}

export function emitAdminLayoutFile(): string {
  return [
    '// Aurexis Forge — admin guard layout (template-emitted, NOT LLM-authored).',
    '//',
    '// Guards EVERY page under /admin: calls requireAdmin() server-side BEFORE',
    '// rendering. A non-admin is redirected. The admin VIEW page is LLM-filled',
    '// but can NEVER render without this structural guard passing first — and',
    '// even if it did, the RLS admin-read policy (barrier 1) still scopes a',
    "// non-admin to their own rows.",
    "import type { ReactNode } from 'react';",
    "import { requireAdmin } from '@/lib/auth/admin';",
    '',
    'export default async function AdminLayout({',
    '  children,',
    '}: {',
    '  children: ReactNode;',
    '}): Promise<JSX.Element> {',
    '  await requireAdmin();',
    '  return <>{children}</>;',
    '}',
    '',
  ].join('\n');
}

// ===========================================================================
// COMPOSITE EXPANSION — deterministic descriptor set for tests + docs.
// ===========================================================================
export interface AdminAtomicSlot {
  readonly kind:
    | 'admin_read_policy'
    | 'admin_guard'
    | 'admin_layout'
    | 'admin_view_page';
  readonly structural: boolean; // true = never reaches the LLM
  readonly readOnly: boolean; // true = no write capability
  readonly path: string;
  readonly target: string;
}

export interface AdminDashboardExpansion {
  readonly entities: ReadonlyArray<string>;
  readonly slots: ReadonlyArray<AdminAtomicSlot>;
  readonly page: AdminDashboardPageDescriptor;
}

export function expandAdminDashboard(spec: SoftwareSpec): AdminDashboardExpansion | null {
  const entities = adminViewableEntities(spec);
  if (!spec.admin_dashboard || entities.length === 0) return null;
  const slots: AdminAtomicSlot[] = [
    // BARRIER 1 — one additive read-only RLS policy per admin-viewable table.
    ...entities.map((name) => ({
      kind: 'admin_read_policy' as const,
      structural: true,
      readOnly: true,
      path: 'supabase/migrations/0001_init.sql',
      target: tableName(name),
    })),
    // BARRIER 2 — server-side guard + guarded layout.
    { kind: 'admin_guard', structural: true, readOnly: true, path: ADMIN_GUARD_PATH, target: 'requireAdmin' },
    { kind: 'admin_layout', structural: true, readOnly: true, path: ADMIN_LAYOUT_PATH, target: ADMIN_DASHBOARD_PAGE_ID },
    // The ONLY LLM-filled artefact: the admin VIEW UI inside the guarded shell.
    { kind: 'admin_view_page', structural: false, readOnly: true, path: 'app/(app)/admin/page.tsx', target: ADMIN_DASHBOARD_PAGE_ID },
  ];
  return {
    entities,
    slots,
    page: adminDashboardPages(spec)[0]!,
  };
}
