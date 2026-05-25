# governance

The safety wall. Every cost-incurring or autonomous code path passes through
one guard: [`assertAllowed()`](./guard.ts). The guard is **fail-closed** —
any internal error becomes a block, never a free pass.

## Files

- `pricing.ts` — pricing config. Reasonable placeholders for current
  Anthropic + E2B rates with a **clear "SET CURRENT RATES" note**. Override
  via env: `PRICING_LLM_INPUT_PER_MTOK_<MODEL_SLUG>` etc.
- `ledger.ts` — `recordCost()` + `getSpendUsd()` + `getRecentCostEvents()`.
- `killswitch.ts` — `activeKillSwitch()`, `setKillSwitch()`,
  `clearKillSwitch()`. Three scopes: `global` | `user` | `project`.
- `guard.ts` — `assertAllowed({ user_id, project_id?, projectedCostUsd? })`.
  Order of checks: kill switch → budget cap → return. Fail closed.
- `budgets.ts` — thin DB CRUD for budgets.

## The contract — every choke point must call the guard

| Choke point                         | Where                                                                | Cost recorded |
| ----------------------------------- | -------------------------------------------------------------------- | ------------- |
| LLM call                            | `lib/engine/llm.ts` `complete()` — before AND after every request    | `kind='llm'` with real usage |
| Sandbox run                         | `lib/engine/sandbox/runner.ts` `runSandbox()` — in `finally`         | `kind='sandbox'` with compute_ms |
| Runtime tick                        | `lib/engine/runtime/scheduler.ts` — kill switch at tick, guard per run | `kind='runtime'` with compute_ms |
| Action routes (spec/plan/build/…)   | At route entry; reuses the same guard                                | (no direct cost) |

The LLM wrapper auto-routes every call through the guard. There is no
escape hatch — adding one is a security regression.

## Fail-closed posture

If the guard's internal lookup (kill switches / budgets / spend) throws for
ANY reason, the guard wraps the error in `GovernanceError('internal_check_failed')`
and the route returns `402` (or `503` for kill). This prevents an unbounded
spend path when the governance DB is misbehaving.

## State

```
cost_events    — append-only ledger; one row per LLM/sandbox/runtime event
budgets        — (user, period) → limit_usd + hard_cap
kill_switches  — append-only history; queries filter active=true
```

## Auto-pause on budget hit

When a scheduled runtime tick fires and the user's budget is exhausted, the
runtime flips to `errored` and emits `runtime.budget_paused` to the audit
log. Resume requires the user to either clear the budget (or raise it) and
explicitly resume.

## Auth + RLS

Per-user isolation lives elsewhere (`lib/auth.ts`, `middleware.ts`,
`supabase/migrations/0009_governance.sql`), but ties in here:

- Every cost event is stamped with `user_id` from `requireUser()`.
- Budgets are unique per `(user_id, period)`.
- RLS policies on `cost_events`, `budgets`, and `kill_switches` mean even a
  forgotten ownership check in a route handler can't leak data across users.

## Audit log emissions

- `budget.set` — period, limit_usd, hard_cap (or `deleted: true`)
- `killswitch.activated` — scope, scope_id, reason, set_by
- `killswitch.cleared` — scope, scope_id, cleared_by
- `action.blocked_budget` — projected vs current spend
- `action.blocked_killswitch` — scope of the active switch
- `runtime.budget_paused` — runtime auto-paused on budget exhaustion

Costs go to `cost_events` (high-cardinality ledger), NOT audit. Audit stays
a high-signal stream of meaningful events.
