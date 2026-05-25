# sandbox

Runs the generated agent in a **fresh, disposable, isolated** environment to
prove it builds and runs. This is the security perimeter — generated code
**only** executes here, never on the Forge host.

## Files

- `provider.ts` — `SandboxProvider` interface + `selectProvider()` factory.
- `providers/e2b.ts` — E2B-backed provider. E2B is purpose-built for
  executing untrusted AI-generated code (each `Sandbox.create()` is a
  fresh isolated VM). The SDK is dynamically imported so the package only
  loads when actually needed.
- `providers/local-docker.ts` — clearly stubbed placeholder for later
  self-hosting; throws a clear message until properly hardened.
- `smoke.ts` — synthesises a `forge_smoke.mjs` driver per trigger (chat /
  api / schedule / webhook). Tries the entrypoint, then `src/agent.ts`,
  then `src/agent.js`; on a recognised `AgentDefinition`, invokes
  `runOnce(agent, syntheticInput)`.
- `runner.ts` — the strict-order pipeline. Always destroys the sandbox in
  a `finally` block.
- `persistence.ts` — DB transitions for `sandbox_runs` + audit-log writes.

## Non-negotiable security contract

1. **Untrusted execution**: generated code only runs inside the provider's
   sandbox, never on the Forge process.
2. **No platform secrets cross the boundary**: the runner only ever passes
   `NODE_ENV`, `CI`, and (during smoke) `FORGE_MOCK_TOOLS=1`,
   `FORGE_NETWORK_DISABLED=1` into the sandbox. `process.env` of the Forge
   process is **never** forwarded.
3. **Network egress disabled for smoke**: the scaffold tool library
   short-circuits to mocked canned data when `FORGE_MOCK_TOOLS=1`, so the
   smoke phase makes zero real network calls regardless of the provider's
   network settings.
4. **Mocked tools**: every tool (`web_search`, `http_request`,
   `llm_completion`, `file_read`, `file_write`, `schedule`, `email_read`,
   `email_send`) checks `isMockMode(ctx)` first and returns canned data.
   Real API calls, file writes, and email sends never happen during smoke.
5. **Hard timeouts**: install (120s), build (90s), smoke (15–25s by
   trigger). The provider enforces each, and the sandbox lifetime is
   capped at 6 minutes total.
6. **Always destroyed**: `provider.destroy()` runs in a `finally` block
   no matter what happens — exception, timeout, or clean exit. `destroy()`
   never throws (errors are swallowed internally).

## State machine on `builds.status` (sandbox phase)

```
generated → testing → tested
              │
              ▼
          test_failed   (re-test or regenerate; manual refine in plan)
```

`sandbox_runs.status`:
- `running` — run in flight
- `passed`  — build_ok AND smoke_ok
- `failed`  — otherwise (or crashed)

## Concurrency

A second test for the same build is refused while one is `running`, with a
zombie-reaper that ignores runs older than 15 minutes (so a crashed run
can't lock the build forever).

## Route

- `POST /api/projects/[id]/build/test` — guard: build is `generated`;
  refuse if a sibling sandbox_run is currently `running`.

## Audit log

- `build.test_started` — provider, build_id, run_id.
- `build.test_passed`  — durations, iterations, phases summary.
- `build.test_failed`  — failing_phase, error, durations, iterations
                         (or `crashed: true` if the runner itself threw).

## Self-heal (not yet wired)

The runner returns `iterations: 0` and the DB schema records it; the loop
itself is intentionally **not** implemented in this commit. When wired:
on smoke failure, feed the captured error back to codegen for at most 2
repair passes on the failing files, re-test, and stop. Bounded.
