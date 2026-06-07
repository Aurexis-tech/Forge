-- Aurexis Forge — spec confidence map.
--
-- Additive column on `specs`. Stores the per-top-level-field
-- confidence map produced alongside the spec by the per-mold
-- extractor (lib/engine/spec/confidence.ts). Existing reads
-- ignore this column; the clarification-loop persistence writes
-- it and the (next) show-spec gate UI reads it.
--
-- SHAPE: { [field_name]: 'stated' | 'inferred' | 'guessed' | 'missing' }.
-- Validated by TypeScript / Zod at the application layer; we don't
-- pin a CHECK constraint here because the field set evolves with
-- the per-mold schema, and the source of truth lives in code.
--
-- RLS POSTURE: the `specs` table already has RLS policies scoping
-- rows to the owning user via `project_id -> projects.user_id`.
-- Adding a column does not change row-visibility, so no new
-- policy is required.

alter table specs add column if not exists confidence_json jsonb;

comment on column specs.confidence_json is
  'Per-top-level-field confidence map (stated | inferred | guessed | missing). Optional metadata produced by lib/engine/spec/confidence.ts; consumed by the clarification loop + the show-spec gate. Existing reads ignore this column.';
