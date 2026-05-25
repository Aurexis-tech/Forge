# planner

Turns a **confirmed** `AgentSpec` into a grounded, validated `BuildPlan` that
the codegen layer (next prompt) will execute.

## Files

- `registry.ts` — the static V1 tool registry. The planner is allowed to
  ground capabilities **only** against entries here.
- `schema.ts` — Zod `BuildPlanSchema` (single source of truth for the shape),
  `validateTaskGraph` (unique ids / valid refs / no cycles), and
  `validatePlanTools` (no hallucinated registry_ids or env_keys).
- `prompts.ts` — system + user message builders.
- `plan.ts` — the pipeline: LLM → Zod → DAG/registry checks → repair retry.
- `persistence.ts` — DB transitions, audit-log writes, and the
  "confirmed spec" guard helper.

## Grounding

For every `capability` in the spec, the planner emits exactly one entry in
`tools[]`. The status field is constrained:

| outcome                              | status        | registry_id |
| ------------------------------------ | ------------- | ----------- |
| matches a registry tool, no key      | `supported`   | tool id     |
| matches a registry tool, needs setup | `needs_key`   | tool id     |
| no reasonable registry mapping       | `unsupported` | `null`      |

`unsupported` capabilities also show up in `warnings[]`. The planner is
explicitly forbidden from inventing new tool ids — the gate validator
(`validatePlanTools`) catches drift.

## State machine on `plans.status`

```
pending → planning → awaiting_review → approved
            │              │
            ▼              ▼
          failed       (refine triggers another planning pass)
```

## Routes

- `POST /api/projects/[id]/plan/generate` — guard: spec confirmed → produce + store plan.
- `POST /api/projects/[id]/plan/refine`   — body `{ note: string }` → re-plan.
- `POST /api/projects/[id]/plan/approve`  — re-validate stored plan → lock.

## Gates

- **Spec must be confirmed** before generate / refine run. The persistence
  helper `loadProjectWithConfirmedSpec` returns a typed error otherwise.
- **Plan must be `awaiting_review`** before approve runs.
- **Approve re-runs the full validation chain** — schema, DAG, and registry —
  so a schema bump can't silently lock a stale plan.

## Audit log

- `plan.generated` — model, attempts, usage, tool coverage, task count.
- `plan.approved`  — actor=user, plan_id.
- `plan.failed`    — error message.

Token usage flows into the same audit table the spec engine writes to. The
future cost-governance layer reads both.
