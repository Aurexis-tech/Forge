# codegen

Turns an approved `BuildPlan` into a complete set of agent source files,
statically checked and stored in `build_files`. **This layer never executes
the generated code** — that's the next layer (sandbox).

## Files

- `scaffold/agent-node-tool-using.ts` — every file the deterministic scaffold
  materialises (package.json, tsconfig, runtime harness, tool library), as
  inline string constants. Bundle-safe; no fs reads at runtime.
- `scaffold/index.ts` — scaffold lookup. Unknown scaffold ids fall back to
  the default with a warning.
- `staticcheck.ts` — `staticCheckFile()` runs `esbuild.transform` (parse +
  transpile only, no execution) for `.ts` / `.tsx` / `.js` / `.jsx` /
  `.mjs` / `.cjs`, and `JSON.parse` for `.json`. Everything else is skipped.
- `prompts.ts` — system + user message builders for per-file generation.
- `generate.ts` — the pipeline: materialise scaffold → for each plan file
  not covered by scaffold, prompt the LLM → static-check → repair retry on
  failure → mark file failed if still broken.
- `persistence.ts` — DB transitions, build_files writes, audit-log entries.

## Security boundary

`esbuild.transform` is the **only** thing this layer does with generated
code. It is purely syntactic — no module resolution, no eval, no
`new Function`, no import side-effects. The bytes never reach Node's
`require` / `import`. The sandbox layer (next prompt) is the first place
generated code is allowed to run.

## State machine on `builds.status` (codegen phase)

```
queued → generating → generated
            │
            ▼
          failed   (retry via /build/generate from this state)
```

Regenerate always inserts a fresh build row; the latest wins in the UI.

## Routes

- `POST /api/projects/[id]/build/generate`   — guard: plan approved → materialise + generate + persist.
- `POST /api/projects/[id]/build/regenerate` — always insert a fresh build row.

Both refuse to clobber a build that is already past codegen (`generated`,
`running`, `success`). Use **regenerate** to start a new one.

## Audit log

- `build.codegen_started`   — build_id, plan_id.
- `build.codegen_completed` — files_total, scaffold_count, generated_count,
                              llm_files_failed, usage, attempts, models,
                              scaffold_id, warnings_count.
- `build.codegen_failed`    — error message.

The next layer (sandbox) will gate on `build.status === 'generated'`.
