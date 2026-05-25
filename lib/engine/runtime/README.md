# runtime

Hosts the always-on / scheduled agents the deploy step deferred.

**V1 model — be honest**: cron-driven PERIODIC execution. Each tick spins
up a fresh isolated sandbox, runs one execution with real tools, captures
the result, and destroys the sandbox. Truly persistent long-lived
processes are a documented future enhancement; we are not faking them.

## Files

- `cron.ts` — minimal cron-next helper. Supports a subset of expressions
  (`* * * * *`, `*/N * * * *`, `0 * * * *`, `0 */N * * *`, `M H * * *`)
  and falls back to "every 5 minutes" for anything else. `describeCron()`
  emits a human-readable label for the UI.
- `executor.ts` — single execution. Reuses the sandbox provider in **LIVE
  mode**: real tools, network on, real env injected, hard wall-clock cap
  per run, sandbox ALWAYS destroyed in a finally block.
- `scheduler.ts` — `tickRuntimes()` (cap-aware, due-only) and `runOnce()`
  (shared by the cron tick and the run-now route). Per-runtime and global
  concurrency caps prevent resource storms.
- `persistence.ts` — DB transitions for `agent_runtimes` + `runs`, env
  encrypt/decrypt, audit-log writes, run accounting (consecutive-fails
  → auto-pause).

## Security contract

- The runtime executes generated code, so it ONLY ever runs inside the
  sandbox provider (E2B by default). The Forge host never imports the
  agent.
- Real env values are encrypted at rest with `APP_ENC_KEY` (AES-256-GCM)
  and decrypted only into the in-memory `env` map passed to the executor.
  After the run finishes, the executor drops the env from its local
  scope. The plaintext is never logged, never returned, never stored in
  any other table.
- Each run has a hard wall-clock cap (`agent_runtimes.max_run_ms`,
  default 60 s) on top of the sandbox's lifetime cap.
- Auto-pause: 3 consecutive failed runs flip the runtime to `errored` and
  clear `next_run_at` so the scheduler stops picking it up. A successful
  run resets the counter.

## State machine

```
                            activate (gate)
                                │
                                ▼
                            ┌────────┐
                       ┌───▶│ active │◀────────┐
                       │    └───┬────┘         │
                       │        │ tick / run-now
                       │        ▼              │
                       │    ┌────────┐         │
                       │    │ running│         │
                       │    └───┬────┘         │
                       │  ok ◀──┼──▶ fail++    │
                       │        │              │
                       │   pause│      ▲       │
                       │        ▼      │ resume│ resume
                       │    ┌────────┐ │       │
                       │    │ paused │─┘       │
                       │    └────────┘         │
                       │                       │
                       │   3 consecutive fails │
                       │        │              │
                       │        ▼              │
                       │    ┌────────┐         │
                       │    │ errored│─────────┘
                       │    └────────┘
                       │        │
                       │   stop │
                       │        ▼
                       │    ┌────────┐
                       └────│ stopped│
                            └────────┘
```

`builds.status` reflects this: `running` when any runtime row exists in
{active, paused, errored}, back to `pushed` when stopped.

## Routes

- `POST /api/runtime/tick` — CRON_SECRET-protected. Vercel Cron is
  configured in `vercel.json` to hit it every minute. Accepts both GET
  (Vercel) and POST (manual tooling). Returns a summary of the tick.
- `POST /api/projects/[id]/runtime/activate` — guarded, requires
  `{ "authorized": true, "cron", "env", "mode", "max_run_ms" }`. Creates
  an `agent_runtimes` row, encrypts the env, schedules the first tick.
- `POST /api/projects/[id]/runtime/pause`  — clears `next_run_at`.
- `POST /api/projects/[id]/runtime/resume` — schedules next tick, resets
  `consecutive_fails`.
- `POST /api/projects/[id]/runtime/stop`   — final state, build returns
  to `pushed` so the user can re-activate.
- `POST /api/projects/[id]/runtime/run-now` — manual one-shot, same
  executor path, records a `runs` row with `trigger='manual'`.

## Audit log

- `runtime.activated` — actor=user, cron, mode, env_keys, max_run_ms
- `runtime.paused` / `runtime.resumed` / `runtime.stopped`
- `run.started` — runtime_id, run_id, trigger
- `run.succeeded` / `run.failed` — duration, error (on failure)
- `runtime.auto_paused` — consecutive_fails snapshot

## Known limitations (future work)

- Each tick re-installs deps from scratch. Pre-warmed sandboxes would
  dramatically cut latency for high-frequency cadences.
- Real long-lived processes (websocket consumers, streaming pipelines)
  aren't supported. They're a different runtime model.
- Cron expressions are constrained to the subset listed above.
