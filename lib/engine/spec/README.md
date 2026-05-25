# spec

Turns `specs.raw_prompt` into a validated `AgentSpec` JSON, with a built-in
clarification + review loop.

## Files

- `schema.ts` — Zod schema. The **single source of truth** for the spec shape.
  Downstream layers import `AgentSpec` from here.
- `prompts.ts` — system + user message builders. All wording lives here so
  it's easy to iterate.
- `extract.ts` — the extraction pipeline. Pass 1 → repair retry → returns a
  validated `ExtractionResult`.
- `persistence.ts` — DB transitions (mark extracting / persist result / mark
  failed / confirm) and audit-log writes. Server-only.

## State machine on `specs.status`

```
            ┌──────────────────────────┐
            ▼                          │
 pending ── ▶ extracting ──▶ needs_clarification ──▶ extracting ──▶ awaiting_review ──▶ confirmed
            │                          ▲                         │
            ▼                          │                         ▼
          failed ──────────────────────┴─────────────────────► (refine triggers another extracting pass)
```

- **pending** — row created at project creation; no extraction yet.
- **extracting** — LLM call in flight.
- **needs_clarification** — a draft spec is saved, plus 1–3 questions in
  `specs.open_questions`. The UI prompts the user; submitting answers runs a
  refining pass.
- **awaiting_review** — a clean spec is in `specs.structured_spec`. The UI
  renders it for the user, with **Confirm** and **Refine** controls.
- **confirmed** — spec is locked. Downstream build phases (planner, codegen,
  …) refuse to run until this status is reached.
- **failed** — extraction couldn't produce a valid spec even after repair.
  The UI offers a retry.

## Routes

All server-only:

- `POST /api/projects/[id]/spec/generate` — first-pass extraction.
- `POST /api/projects/[id]/spec/clarify`  — body `{ answers: [{question, answer}, …] }`.
- `POST /api/projects/[id]/spec/refine`   — body `{ note: string }`.
- `POST /api/projects/[id]/spec/confirm`  — locks the spec.

## Audit log

Every transition writes to `audit_log`:

- `spec.draft_generated` — model, attempts, usage, confidence.
- `spec.clarification_asked` — the questions + usage.
- `spec.confirmed` — actor=user, spec_id.
- `spec.extraction_failed` — error message.

This is the data the future cost-governance layer will read.
