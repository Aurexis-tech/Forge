// Pure-logic graph derivation for the Phase 3 software planner.
//
// Takes a SoftwareSpec and produces a base task DAG by mapping the
// spec onto the vetted template's slots:
//
//   schema layer  — one entity_migration per entity
//                   + one rls_policy per entity when per_user_isolation
//   api layer     — list/create/update/delete routes for each entity,
//                   only the subset implied by the spec's flows (with a
//                   sensible default: list + create for every entity)
//   ui layer      — one page_component per page in the spec
//   auth layer    — session_middleware (always) + role_gate (if roles)
//                   + per_user_isolation_check (if per_user_isolation)
//
// Edges encode the inter-layer dependencies:
//
//   schema → api → ui
//                ↘ auth wiring depends on schema
//
// The REUSED Phase 1 validateTaskGraph runs over the result so cyclic
// graphs are rejected with a consistent error shape across phases.
// Cycles are not expected from this deterministic mapping but the
// check is run defensively + because the LLM detail pass downstream
// might add tasks the user crafted in a refinement.

import {
  validateTaskGraph,
  type DagIssue,
  type PlanTask,
} from '@/lib/engine/planner/schema';
import type { SoftwareSpec } from '../spec';
import {
  SLOT_LAYER,
  type LayerId,
  type SlotKind,
} from './template';
import {
  crudResourcePageDescriptor,
  expandCrudResource,
} from '../codegen/crud-resource';
import { fileUploadGalleryPages } from '../codegen/file-upload';
import {
  adminDashboardPages,
  adminViewableEntities,
} from '../codegen/admin-dashboard';

// Same shape as system/planner/graph.ts so the route/UI layer can
// treat both graphs uniformly when it needs to.
export interface SoftwareDerivedTask {
  id: string;
  layer: LayerId;
  description: string;
  depends_on: string[];
  slot: { kind: SlotKind; target: string | null };
  files: string[];
}

export interface SoftwareDerivedGraph {
  tasks: SoftwareDerivedTask[];
  executionOrder: string[];
  // Per-task: which upstream task ids feed it. Built from depends_on.
  upstreamByTask: Record<string, string[]>;
  // Issues from the REUSED Phase 1 cycle check. Empty array = healthy.
  issues: DagIssue[];
}

export class SoftwareGraphError extends Error {
  readonly issues: DagIssue[];
  constructor(message: string, issues: DagIssue[]) {
    super(message);
    this.name = 'SoftwareGraphError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Helpers — id generation. Build deterministic, human-readable task ids
// so the LLM detail pass + the audit trail can reference them by name.
// ---------------------------------------------------------------------------

// Map a PascalCase entity name to a lower_snake_case id stem.
function entitySlug(name: string): string {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function deriveSoftwareGraph(spec: SoftwareSpec): SoftwareDerivedGraph {
  const tasks: SoftwareDerivedTask[] = [];

  // CRUD-resource opt-in: entities listed in spec.crud_resources expand
  // via the deterministic COMPOSITE (complete owner-scoped CRUD) instead
  // of the conditional per-entity derivation. Filtered to real entities;
  // the spec validator already rejects unknown names + non-isolated auth.
  const crudSet = new Set(
    (spec.crud_resources ?? []).filter((n) =>
      spec.entities.some((e) => e.name === n),
    ),
  );

  // --- 1. Schema layer ---------------------------------------------------
  // One entity_migration per entity. Plus an rls_policy declaration when
  // per_user_isolation is true (template-provided policy template).
  const migrationIdByEntity = new Map<string, string>();
  const rlsIdByEntity = new Map<string, string>();

  for (const entity of spec.entities) {
    const slug = entitySlug(entity.name);
    const migrationId = 'migration_' + slug;
    migrationIdByEntity.set(entity.name, migrationId);
    tasks.push({
      id: migrationId,
      layer: 'schema',
      description:
        "Create the '" +
        entity.name +
        "' table with " +
        entity.fields.length +
        ' fields.',
      depends_on: [],
      slot: { kind: 'entity_migration', target: entity.name },
      files: ['supabase/migrations/<n>_' + slug + '.sql'],
    });

    if (spec.auth.per_user_isolation) {
      const rlsId = 'rls_' + slug;
      rlsIdByEntity.set(entity.name, rlsId);
      tasks.push({
        id: rlsId,
        layer: 'schema',
        description:
          "Declare per-user row-level-security policy on '" +
          entity.name +
          "' (template-provided RLS template).",
        depends_on: [migrationId],
        slot: { kind: 'rls_policy', target: entity.name },
        files: ['supabase/migrations/<n>_' + slug + '.sql'],
      });
    }
  }

  // --- 2. API layer ------------------------------------------------------
  // Default: every entity gets a list + create route. Update + delete are
  // added when the spec's flows mention them; otherwise the planner stays
  // conservative (less surface area to secure later).
  const flowText = spec.flows
    .map((f) => f.name + ' ' + f.description)
    .join(' ')
    .toLowerCase();

  function flowsImply(verb: 'update' | 'delete'): boolean {
    if (verb === 'update') {
      return /\bupdate|edit|approve|reject|modify|change\b/.test(flowText);
    }
    return /\bdelete|remove|archive|discard\b/.test(flowText);
  }

  const routeIdsByEntity = new Map<string, string[]>();

  for (const entity of spec.entities) {
    const slug = entitySlug(entity.name);
    const migrationDep = migrationIdByEntity.get(entity.name);
    if (!migrationDep) continue; // unreachable — every entity got one above

    // CRUD-resource composite: complete owner-scoped CRUD — all 5 routes
    // (create / list / get / update / delete), deterministically. The
    // owner-scoping is structural (migration owner_id + RLS, route family
    // owner-pin); the composite only decides the topology.
    if (crudSet.has(entity.name)) {
      const expansion = expandCrudResource(
        { name: entity.name, fields: entity.fields },
        { perUserIsolation: spec.auth.per_user_isolation },
      );
      const crudRoutes: string[] = [];
      for (const r of expansion.routes) {
        const stem = r.kind.replace('_route', ''); // create/list/get/update/delete
        const isItem =
          r.kind === 'get_route' ||
          r.kind === 'update_route' ||
          r.kind === 'delete_route';
        const routeId = 'api_' + stem + '_' + slug;
        tasks.push({
          id: routeId,
          layer: 'api',
          description:
            r.method +
            ' /api/' +
            slug +
            (isItem ? '/[id]' : '') +
            ' — ' +
            stem +
            ' ' +
            entity.name +
            ' (owner-scoped CRUD-resource).',
          depends_on: [migrationDep],
          slot: { kind: r.kind, target: entity.name },
          files: ['app/api/' + slug + (isItem ? '/[id]' : '') + '/route.ts'],
        });
        crudRoutes.push(routeId);
      }
      routeIdsByEntity.set(entity.name, crudRoutes);
      continue;
    }

    const entityRoutes: string[] = [];

    // list — always
    const listId = 'api_list_' + slug;
    tasks.push({
      id: listId,
      layer: 'api',
      description:
        'GET /api/' + slug + ' — list ' + entity.name + ' rows.',
      depends_on: [migrationDep],
      slot: { kind: 'list_route', target: entity.name },
      files: ['app/api/' + slug + '/route.ts'],
    });
    entityRoutes.push(listId);

    // create — always
    const createId = 'api_create_' + slug;
    tasks.push({
      id: createId,
      layer: 'api',
      description:
        'POST /api/' + slug + ' — create a new ' + entity.name + ' row.',
      depends_on: [migrationDep],
      slot: { kind: 'create_route', target: entity.name },
      files: ['app/api/' + slug + '/route.ts'],
    });
    entityRoutes.push(createId);

    if (flowsImply('update')) {
      const updateId = 'api_update_' + slug;
      tasks.push({
        id: updateId,
        layer: 'api',
        description:
          'PATCH /api/' + slug +
          '/[id] — update an existing ' + entity.name + ' row (flow-implied).',
        depends_on: [migrationDep],
        slot: { kind: 'update_route', target: entity.name },
        files: ['app/api/' + slug + '/[id]/route.ts'],
      });
      entityRoutes.push(updateId);
    }

    if (flowsImply('delete')) {
      const deleteId = 'api_delete_' + slug;
      tasks.push({
        id: deleteId,
        layer: 'api',
        description:
          'DELETE /api/' + slug +
          '/[id] — delete a ' + entity.name + ' row (flow-implied).',
        depends_on: [migrationDep],
        slot: { kind: 'delete_route', target: entity.name },
        files: ['app/api/' + slug + '/[id]/route.ts'],
      });
      entityRoutes.push(deleteId);
    }

    routeIdsByEntity.set(entity.name, entityRoutes);
  }

  // --- 3. UI layer -------------------------------------------------------
  // One page_component per page. Each page depends on the API routes for
  // entities its flows touch (or all routes if no flow declares the page).
  for (const page of spec.pages) {
    const flowsTouchingPage = spec.flows.filter((f) =>
      (f.pages ?? []).includes(page.id),
    );

    const entitiesUsed = new Set<string>();
    if (flowsTouchingPage.length > 0) {
      // Heuristic: pages-in-flows imply the entities whose names appear
      // in the flow text. Fall back to all entities below if nothing
      // matches — keeps the graph connected so the planner stage shows
      // the user a useful dependency chain.
      for (const f of flowsTouchingPage) {
        const text = (f.name + ' ' + f.description).toLowerCase();
        for (const e of spec.entities) {
          if (text.includes(e.name.toLowerCase())) entitiesUsed.add(e.name);
        }
      }
    }
    if (entitiesUsed.size === 0) {
      for (const e of spec.entities) entitiesUsed.add(e.name);
    }

    const deps: string[] = [];
    for (const eName of entitiesUsed) {
      for (const r of routeIdsByEntity.get(eName) ?? []) deps.push(r);
    }

    tasks.push({
      id: 'page_' + page.id,
      layer: 'ui',
      description: page.purpose,
      depends_on: deps,
      slot: { kind: 'page_component', target: page.id },
      files: ['app/(app)/' + page.id.replace(/_/g, '-') + '/page.tsx'],
    });
  }

  // --- 3b. CRUD-resource pages ------------------------------------------
  // Each CRUD resource gets ONE synthesized server-component page (list +
  // detail view), depending on that resource's routes. The page id is the
  // entity slug; the spec validator guarantees it doesn't collide with a
  // declared page. Iterating spec.entities (filtered to crudSet) keeps the
  // order deterministic.
  for (const entity of spec.entities) {
    if (!crudSet.has(entity.name)) continue;
    const desc = crudResourcePageDescriptor(entity.name);
    tasks.push({
      id: 'page_' + desc.id,
      layer: 'ui',
      description: desc.purpose,
      depends_on: routeIdsByEntity.get(entity.name) ?? [],
      slot: { kind: 'page_component', target: desc.id },
      files: ['app/(app)/' + desc.id.replace(/_/g, '-') + '/page.tsx'],
    });
  }

  // --- 3c. File-upload gallery pages ------------------------------------
  // Each file-upload slot gets ONE synthesized server-component gallery
  // page (lists the user's own files). The upload + signed-URL routes, the
  // storage bucket/policy, and the metadata table are STRUCTURAL (emitted
  // deterministically by the codegen assembler, NOT slot tasks) — only the
  // gallery page is LLM-filled via the page family. The page id is the
  // slot slug + '_files'; the spec validator guarantees no collision.
  for (const galleryPage of fileUploadGalleryPages(spec)) {
    tasks.push({
      id: 'page_' + galleryPage.id,
      layer: 'ui',
      description: galleryPage.purpose,
      depends_on: [],
      slot: { kind: 'page_component', target: galleryPage.id },
      files: ['app/(app)/' + galleryPage.id.replace(/_/g, '-') + '/page.tsx'],
    });
  }

  // --- 3d. Admin dashboard page -----------------------------------------
  // The admin VIEW page (server component, LLM-filled) inside a STRUCTURAL
  // guarded shell. The RLS admin-read policy (barrier 1, in the migration)
  // + the /admin segment guard layout (barrier 2, structural) are emitted
  // deterministically — only this VIEW reaches the LLM. Depends on the
  // migrations of the entities it reads.
  for (const adminPage of adminDashboardPages(spec)) {
    const deps = adminViewableEntities(spec)
      .map((name) => migrationIdByEntity.get(name))
      .filter((id): id is string => Boolean(id));
    tasks.push({
      id: 'page_' + adminPage.id,
      layer: 'ui',
      description: adminPage.purpose,
      depends_on: deps,
      slot: { kind: 'page_component', target: adminPage.id },
      files: ['app/(app)/' + adminPage.id.replace(/_/g, '-') + '/page.tsx'],
    });
  }

  // --- 4. Auth layer -----------------------------------------------------
  // Always: session_middleware. Plus role_gate when roles are declared,
  // and per_user_isolation_check when the spec asked for RLS-style data
  // isolation (depends on every rls_policy task so the wiring lands
  // last). The template provides the actual implementations; these
  // tasks DECLARE that the wiring is required.
  if (spec.auth.requires_auth) {
    tasks.push({
      id: 'auth_session_middleware',
      layer: 'auth',
      description:
        'Wire the template-provided Supabase session middleware (refresh + redirect-to-sign-in).',
      depends_on: [],
      slot: { kind: 'session_middleware', target: null },
      files: ['middleware.ts'],
    });

    if (spec.auth.roles && spec.auth.roles.length > 0) {
      tasks.push({
        id: 'auth_role_gate',
        layer: 'auth',
        description:
          'Wire the template-provided role gate for roles: ' +
          spec.auth.roles.join(', ') +
          '.',
        depends_on: ['auth_session_middleware'],
        slot: { kind: 'role_gate', target: null },
        files: ['lib/auth/roles.ts'],
      });
    }

    if (spec.auth.per_user_isolation) {
      const rlsDeps = Array.from(rlsIdByEntity.values());
      tasks.push({
        id: 'auth_per_user_isolation',
        layer: 'auth',
        description:
          'Declare per-user data isolation across all entities; relies on the rls_policy tasks above (template handles the actual policies).',
        depends_on: rlsDeps.length > 0 ? rlsDeps : ['auth_session_middleware'],
        slot: { kind: 'per_user_isolation_check', target: null },
        files: ['lib/auth/rls.ts'],
      });
    }
  }

  // --- 5. Cycle check (REUSE Phase 1 validateTaskGraph) ------------------
  // Convert SoftwareDerivedTask → PlanTask shape so we share Kahn topo
  // sort + dup + unknown-dep detection with the agent + system planners.
  const planTasks: PlanTask[] = tasks.map((t) => ({
    id: t.id,
    title: t.id,
    description: t.description,
    depends_on: t.depends_on,
  }));
  const issues = validateTaskGraph(planTasks);
  if (issues.length > 0) {
    throw new SoftwareGraphError(
      'software build graph rejected: ' +
        issues.map((i) => '[' + i.kind + '] ' + i.message).join('; '),
      issues,
    );
  }

  // --- 6. Topological execution order -----------------------------------
  const upstreamByTask: Record<string, string[]> = {};
  for (const t of tasks) upstreamByTask[t.id] = [...t.depends_on];

  const executionOrder = topoSort(
    tasks.map((t) => t.id),
    upstreamByTask,
  );

  return {
    tasks,
    executionOrder,
    upstreamByTask,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// Kahn topological sort. We've already proven the graph is acyclic via
// validateTaskGraph above; this just produces a deterministic order.
// Within each "ready" wave we sort by the task's layer (schema → api →
// ui → auth) so the UI list reads in build-order naturally.
// ---------------------------------------------------------------------------

const LAYER_ORDER: Record<LayerId, number> = {
  schema: 1,
  api: 2,
  ui: 3,
  auth: 4,
};

function topoSort(
  taskIds: readonly string[],
  upstream: Record<string, string[]>,
): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const layerOf = new Map<string, number>();
  for (const id of taskIds) {
    indeg.set(id, 0);
    adj.set(id, []);
    // Derive layer order from the slot.kind via SLOT_LAYER; we don't
    // have the task object here so use a sentinel default.
    layerOf.set(id, 99);
  }
  for (const id of taskIds) {
    for (const dep of upstream[id] ?? []) {
      const a = adj.get(dep);
      if (a) a.push(id);
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
    }
  }
  // Helper used by the wave-sort below — we don't have the SoftwareTask
  // here so we approximate the layer from the id prefix (set in
  // deriveSoftwareGraph above). The approximation is stable + cheap;
  // anything that doesn't match falls into the lowest-priority bucket.
  function layerScore(id: string): number {
    if (id.startsWith('migration_') || id.startsWith('rls_')) return LAYER_ORDER.schema;
    if (id.startsWith('api_')) return LAYER_ORDER.api;
    if (id.startsWith('page_')) return LAYER_ORDER.ui;
    if (id.startsWith('auth_')) return LAYER_ORDER.auth;
    return 99;
  }

  const order: string[] = [];
  // Repeatedly pull every task whose in-degree is 0 (a "wave"), sort
  // the wave by layerScore, push, then update in-degrees. This gives a
  // build-order-friendly read even when several tasks are ready at once.
  let remaining = new Set(taskIds);
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      if ((indeg.get(id) ?? 0) === 0) ready.push(id);
    }
    if (ready.length === 0) {
      // Same defensive guard as the system planner — should be
      // unreachable because validateTaskGraph above already ruled out
      // cycles, but if it fires the user sees a clean error.
      throw new SoftwareGraphError(
        'unable to compute a topological execution order',
        [{ kind: 'cycle', message: 'topological sort did not cover every task' }],
      );
    }
    ready.sort((a, b) => layerScore(a) - layerScore(b));
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const next of adj.get(id) ?? []) {
        indeg.set(next, (indeg.get(next) ?? 0) - 1);
      }
    }
  }
  return order;
}
