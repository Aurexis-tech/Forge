// The vetted full-stack template the Phase 3 software planner targets.
//
// "Vetted" means the platform's own shape: a Next.js + Supabase app
// where auth (magic-link), per-user RLS isolation, and the session
// middleware are PROVIDED BY THE TEMPLATE and never re-authored by the
// LLM. Plan tasks FILL slots in this template; they do not invent
// security primitives.
//
// This file is the single source of truth for what the planner can
// produce. Adding a new slot (e.g. a search index, a file upload
// endpoint) requires:
//   1. listing it here,
//   2. teaching graph.ts to emit a task for it when the spec implies it,
//   3. teaching schema.ts to validate the slot.kind enum, and
//   4. (later, P3-3+) wiring the codegen scaffold to fill the slot.

export const TEMPLATE_ID = 'nextjs-supabase-app';

// The four layers the planner organises tasks into. Order matters for
// the topological sort: schema migrations must land before API routes
// can reference them, and so on.
export const LAYERS = [
  { id: 'schema', label: 'Schema & migrations', order: 1 },
  { id: 'api',    label: 'API routes',          order: 2 },
  { id: 'ui',     label: 'UI pages',            order: 3 },
  { id: 'auth',   label: 'Auth & RLS wiring',   order: 4 },
] as const;
export type LayerId = (typeof LAYERS)[number]['id'];

// Every plan task references exactly ONE slot.kind. The catalog below
// is the closed set the LLM is allowed to plan against. Per-entity
// and per-page slots are parameterised by `slot.target` (the entity
// name or page id); template-wide slots (e.g. session middleware) use
// `target: null`.

export const SLOT_KINDS = [
  // schema layer — one entity_migration per entity; one rls_policy per
  // entity when the spec declares per_user_isolation=true.
  'entity_migration',
  'rls_policy',

  // api layer — standard CRUD; the planner emits the subset the flows
  // imply, not all of them for every entity. A CRUD-resource composite
  // emits the full owner-scoped set (create/list/get/update/delete).
  'list_route',
  'create_route',
  'get_route',
  'update_route',
  'delete_route',

  // ui layer — one page_component per page in the spec.
  'page_component',

  // auth layer — TEMPLATE-PROVIDED primitives the planner only
  // declares (it does NOT plan handwritten replacements):
  //   - session_middleware: refresh + redirect-to-sign-in
  //   - role_gate: gate routes by spec.auth.roles
  //   - per_user_isolation_check: wire RLS policies created above
  'session_middleware',
  'role_gate',
  'per_user_isolation_check',
] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

// Which layer each slot kind belongs to. Encoded once so graph.ts +
// schema.ts agree without drift.
export const SLOT_LAYER: Record<SlotKind, LayerId> = {
  entity_migration:          'schema',
  rls_policy:                'schema',
  list_route:                'api',
  create_route:              'api',
  get_route:                 'api',
  update_route:              'api',
  delete_route:              'api',
  page_component:            'ui',
  session_middleware:        'auth',
  role_gate:                 'auth',
  per_user_isolation_check:  'auth',
};

// Compact JSON description of the template the LLM consumes during the
// detail pass. Bounded so we never bloat the prompt.
export function templateForPrompt(): string {
  return JSON.stringify(
    {
      template_id: TEMPLATE_ID,
      layers: LAYERS.map((l) => ({ id: l.id, label: l.label, order: l.order })),
      slots: SLOT_KINDS.map((k) => ({ kind: k, layer: SLOT_LAYER[k] })),
      // Reminder rules included as data so the LLM can't miss them.
      rules: [
        'Tasks must reference slot.kind from this catalog only. Do not invent new slot kinds.',
        'Auth + per-user isolation are template-provided. Plan auth tasks ONLY as declarative wiring (session_middleware, role_gate, per_user_isolation_check) — never as hand-rolled code.',
        'Each entity declared in the spec has exactly ONE entity_migration task. RLS policies are added by the template; the rls_policy task only DECLARES which entity it applies to.',
        'A page_component task targets a real page.id from the spec. A page does not need every CRUD route — emit only the ones flows imply.',
      ],
    },
    null,
    2,
  );
}
