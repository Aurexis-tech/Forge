// Aurexis Forge — Phase 3 (Software) CRUD-resource COMPOSITE slot.
//
// The most universal app primitive: most apps are CRUD over owner-scoped
// resources. A CRUD-resource is a COMPOSITE slot — it EXPANDS
// DETERMINISTICALLY into the EXISTING vetted ATOMIC slots, the same way a
// coordination pattern expands into orchestration nodes:
//
//   SCHEMA  — one owner-scoped table (owner_id + RLS: users see/modify
//             only their own rows). Produced by the structural migration
//             slot (emitSoftwareMigration) — NEVER the LLM.
//   ROUTES  — 5 owner-scoped handlers (create / list / get-by-id /
//             update / delete) via the route family. owner_id is pinned
//             server-side on writes; reads are RLS-scoped.
//   PAGE    — a server-component list + detail view via the page family.
//
// The EXPANSION is structural: the LLM never decides a resource's
// topology (which routes, which table, the owner-scoping). It fills only
// FIELD-SPECIFIC content within the vetted route/page families. This file
// is DATA ONLY — pure, no LLM, no IO — so the expansion is unit-testable
// and deterministic (same resource -> same slot set).
//
// Owner-scoping is NOT freehand: it comes from the structural slots — the
// migration's `owner_id` + per-user RLS policy, and the route family's
// "pin owner_id on writes" criterion. The cross-user RLS isolation
// invariant (lib/engine/software/sandbox/isolation.ts) holds for a
// CRUD-resource exactly as it does for any other owner-scoped entity,
// because it uses the SAME owner-scoped table + policy.

import type { SoftwareSpec } from '../spec';
import type { SlotKind } from '../planner/template';
import { tableName } from './migration';

// The 5 owner-scoped CRUD route slot kinds, in canonical order.
export const CRUD_ROUTE_KINDS = [
  'create_route',
  'list_route',
  'get_route',
  'update_route',
  'delete_route',
] as const;
export type CrudRouteKind = (typeof CRUD_ROUTE_KINDS)[number];

const ROUTE_METHOD: Record<CrudRouteKind, 'GET' | 'POST' | 'PATCH' | 'DELETE'> = {
  create_route: 'POST',
  list_route: 'GET',
  get_route: 'GET',
  update_route: 'PATCH',
  delete_route: 'DELETE',
};

export interface CrudResourceField {
  readonly name: string;
  readonly type: string;
}

export interface CrudResource {
  readonly name: string;
  readonly fields: ReadonlyArray<CrudResourceField>;
}

// One atomic slot the composite expands into. `ownerScoped` is the
// structural marker — true for every CRUD-resource slot (schema owner_id
// + RLS, route owner-pin, RLS-scoped page reads). `method`/`path` are the
// concrete artefacts the atomic slot produces.
export interface CrudAtomicSlot {
  readonly layer: 'schema' | 'api' | 'ui';
  readonly kind: SlotKind;
  // Entity name for schema/api slots; synthesized page id for the ui slot.
  readonly target: string;
  readonly ownerScoped: boolean;
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
}

export interface CrudResourcePageDescriptor {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}

export interface CrudResourceExpansion {
  readonly resource: string;
  readonly table: string;
  readonly perUserIsolation: boolean;
  readonly schema: {
    readonly migration: CrudAtomicSlot;
    // null only when per_user_isolation is off; CRUD-resources require it
    // (enforced at the spec layer), so in practice this is always present.
    readonly rls: CrudAtomicSlot | null;
  };
  readonly routes: ReadonlyArray<CrudAtomicSlot>;
  readonly page: CrudAtomicSlot;
  readonly pageDescriptor: CrudResourcePageDescriptor;
}

const MIGRATION_PATH = 'supabase/migrations/0001_init.sql';

// PascalCase entity -> kebab-case URL segment for the page route.
function kebab(table: string): string {
  return table.replace(/_/g, '-');
}

/**
 * The per-slot file a CRUD route generates. Mirrors slots.ts's
 * `routeSlotPath` — collection methods (list/create) at /api/<table>;
 * item methods (get/update/delete) at /api/<table>/[id].
 */
function routeFilePath(kind: CrudRouteKind, table: string): string {
  switch (kind) {
    case 'list_route':
      return 'app/api/' + table + '/_list.ts';
    case 'create_route':
      return 'app/api/' + table + '/_create.ts';
    case 'get_route':
      return 'app/api/' + table + '/[id]/_get.ts';
    case 'update_route':
      return 'app/api/' + table + '/[id]/_update.ts';
    case 'delete_route':
      return 'app/api/' + table + '/[id]/_delete.ts';
  }
}

/** Synthesized page id for a resource's list+detail view. */
export function crudResourcePageId(entityName: string): string {
  // entity table name is already lower_snake_case (a valid page id).
  return tableName(entityName);
}

/** The synthesized page descriptor for a resource (list + detail view). */
export function crudResourcePageDescriptor(
  entityName: string,
): CrudResourcePageDescriptor {
  return {
    id: crudResourcePageId(entityName),
    name: entityName + ' records',
    purpose:
      'List and view the signed-in user\'s ' +
      entityName +
      ' records (owner-scoped; RLS limits the view to rows the user owns).',
  };
}

/**
 * The synthesized page descriptors for every CRUD-resource declared in a
 * spec (filtered to real entities). Used by BOTH the planner graph (to
 * emit the page task) and the page slot dispatch (to resolve the page's
 * name/purpose, since these pages aren't in spec.pages). One source of
 * truth so the two never drift.
 */
export function crudResourcePages(
  spec: SoftwareSpec,
): CrudResourcePageDescriptor[] {
  const names = spec.crud_resources ?? [];
  const real = new Set(spec.entities.map((e) => e.name));
  return names
    .filter((n) => real.has(n))
    .map((n) => crudResourcePageDescriptor(n));
}

/**
 * Expand a resource into its deterministic atomic-slot set: 1 owner-scoped
 * table (+ RLS), 5 owner-scoped routes, 1 server-component page. PURE —
 * no LLM, no IO. Same resource -> same expansion.
 */
export function expandCrudResource(
  resource: CrudResource,
  opts: { perUserIsolation: boolean },
): CrudResourceExpansion {
  const table = tableName(resource.name);

  const migration: CrudAtomicSlot = {
    layer: 'schema',
    kind: 'entity_migration',
    target: resource.name,
    ownerScoped: true,
    path: MIGRATION_PATH,
  };
  const rls: CrudAtomicSlot | null = opts.perUserIsolation
    ? {
        layer: 'schema',
        kind: 'rls_policy',
        target: resource.name,
        ownerScoped: true,
        path: MIGRATION_PATH,
      }
    : null;

  const routes: CrudAtomicSlot[] = CRUD_ROUTE_KINDS.map((kind) => ({
    layer: 'api' as const,
    kind,
    target: resource.name,
    ownerScoped: true,
    method: ROUTE_METHOD[kind],
    path: routeFilePath(kind, table),
  }));

  const pageDescriptor = crudResourcePageDescriptor(resource.name);
  const page: CrudAtomicSlot = {
    layer: 'ui',
    kind: 'page_component',
    target: pageDescriptor.id,
    ownerScoped: true,
    path: 'app/(app)/' + kebab(table) + '/page.tsx',
  };

  return {
    resource: resource.name,
    table,
    perUserIsolation: opts.perUserIsolation,
    schema: { migration, rls },
    routes,
    page,
    pageDescriptor,
  };
}
