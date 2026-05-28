// SOFTWARE SPEC ADDENDUM — extends lib/engine/spec/quality.ts.
//
// Engine-owned, eval-referenced. Separate from the codegen-side
// software addendum (lib/engine/software/codegen/quality.ts) — that
// one governs ROUTE+PAGE generation; this one governs spec extraction.

import type { SpecQualityCriterion } from '../spec/quality';

export const SOFTWARE_SPEC_ADDENDUM_VERSION = '1.0.0';

export const SOFTWARE_SPEC_ADDENDUM_IDS = [
  'software_pages_and_entities_concrete',
  'software_entity_fields_typed',
  'software_flows_named',
  'software_auth_model_explicit',
] as const;
export type SoftwareSpecAddendumId =
  (typeof SOFTWARE_SPEC_ADDENDUM_IDS)[number];

export const SOFTWARE_SPEC_ADDENDUM: readonly SpecQualityCriterion[] = [
  {
    id: 'software_pages_and_entities_concrete',
    label: 'Pages and entities are named, not implied',
    imperative:
      "Enumerate the pages the user described as `pages[]` with stable ids (`list_expenses`, `new_expense`, `expense_detail`) — kebab-aware lower_snake_case starting with a letter. Enumerate the data entities as `entities[]` with PascalCase names. Do not collapse multiple distinct screens into one generic page.",
    rationale:
      "The planner emits one task per page and one migration per entity. Missing entities can't be added back without re-running the gate.",
  },
  {
    id: 'software_entity_fields_typed',
    label: 'Entity fields have concrete names and a catalog-backed type',
    imperative:
      "Each entity's `fields[]` must carry a lower_snake_case name AND a type from the FIELD_TYPES catalog: string, text, number, boolean, date, datetime, email, url, enum, reference. Generic placeholders like 'various fields' or 'metadata' are not acceptable — list the actual columns the user implied.",
    rationale:
      "The migration emitter walks fields to produce DDL. A vague field list produces a vague (and unsafe) schema.",
  },
  {
    id: 'software_flows_named',
    label: 'Flows describe a named user journey across pages',
    imperative:
      "For every distinct user journey the prompt implies (submit, approve, view-own, etc.) emit one entry in `flows[]` with a short snake_case name + 1 sentence description + the `pages[]` it walks through. A `flows[]` entry referencing a page id that doesn't exist in `pages[]` is a hard-fail.",
    rationale:
      "Flows are how the planner picks which CRUD routes + pages to emit. An app without named flows produces a generic CRUD shell instead of the user's actual journey.",
  },
  {
    id: 'software_auth_model_explicit',
    label: 'Auth model declared; never hand-rolled',
    imperative:
      "Set `auth.requires_auth` (boolean) AND `auth.per_user_isolation` (boolean) explicitly. When the user mentions \"only the owner can see their data\", set per_user_isolation=true. NEVER imply the user wants custom auth (the template enforces Supabase magic-link + RLS); never suggest building login UI or JWT logic.",
    rationale:
      "The template owns auth + RLS. Spec-level confusion here leaks into the slot dispatch and risks the LLM trying to write an alternative auth path that the structural non-negotiables would block.",
  },
];
