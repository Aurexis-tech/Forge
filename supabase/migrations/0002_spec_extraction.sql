-- Aurexis Forge — spec extraction support
-- Adds clarification + feedback fields to specs so the extractor can run a
-- multi-pass loop (draft → ask → refine → review → confirm).

alter table public.specs
  add column if not exists open_questions jsonb,
  add column if not exists feedback jsonb;

-- specs.status now uses an expanded vocabulary:
--   'pending'              — created, not yet extracted
--   'extracting'           — LLM call in flight
--   'needs_clarification'  — draft saved, user must answer open_questions
--   'awaiting_review'      — structured spec ready for user confirm
--   'confirmed'            — spec locked; downstream build can proceed
--   'failed'               — extraction failed; user may retry
-- No CHECK constraint yet — we want freedom while the engine evolves.

create index if not exists specs_status_idx on public.specs (status);
