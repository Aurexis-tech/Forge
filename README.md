# Aurexis Forge

[![CI](https://github.com/AurexisAI/Aurexis-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/AurexisAI/Aurexis-forge/actions/workflows/ci.yml)

Plain-language prompt → deployed AI product.

This repo is the **foundation layer**: a persistent 3D world (the "Forge")
with crisp DOM overlays on top, backed by a Supabase data layer. Spec
parsing, code generation, sandbox execution, GitHub, and Vercel deploy
all live behind reserved engine slots and arrive in later commits.

## Stack

- Next.js 14 (App Router) + TypeScript (strict)
- Tailwind CSS for the DOM layer
- `three` + `@react-three/fiber` + `@react-three/drei` + `@react-three/postprocessing` for the world
- `zustand` for shared UI/world state
- Supabase (Postgres) via `@supabase/supabase-js`
- Deploys to Vercel (later)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy the template and fill in your Supabase keys:

   ```bash
   cp .env.example .env.local
   ```

   - `NEXT_PUBLIC_SUPABASE_URL` — your project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — public anon key
   - `SUPABASE_SERVICE_ROLE_KEY` — **server only**, never expose to the browser
   - `ANTHROPIC_API_KEY` — **server only**, used by the spec extractor + planner
   - `ANTHROPIC_MODEL` — defaults to `claude-sonnet-4-6`, override to swap
   - `ANTHROPIC_PLANNER_MODEL` — optional override just for the planner;
     falls back to `ANTHROPIC_MODEL` if unset
   - `ANTHROPIC_CODEGEN_MODEL` — optional override just for codegen;
     falls back to `ANTHROPIC_PLANNER_MODEL` if unset
   - `SANDBOX_PROVIDER` — `e2b` (default) or `local-docker` (stub)
   - `E2B_API_KEY` — **server only**, never enters the sandbox itself
   - `APP_BASE_URL` — e.g. `http://localhost:3000`; used for OAuth callbacks
   - `APP_ENC_KEY` — **server only**, base64 32 bytes; AES-256-GCM key for
     encrypting stored OAuth tokens. Generate with
     `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`
   - `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` — OAuth App
     credentials from <https://github.com/settings/developers>, callback URL
     `${APP_BASE_URL}/api/connections/github/callback`
   - `VERCEL_OAUTH_CLIENT_ID` / `VERCEL_OAUTH_CLIENT_SECRET` /
     `VERCEL_INTEGRATION_SLUG` — optional Vercel integration. If blank,
     the UI falls back to a Personal Access Token paste flow
     (`https://vercel.com/account/tokens`)
   - `CRON_SECRET` — **server only**, required for the runtime tick
     endpoint. When set, Vercel Cron auto-attaches it as
     `Authorization: Bearer ${CRON_SECRET}`
   - `PRICING_*` — optional overrides for cost-ledger rates (see
     `lib/engine/governance/pricing.ts`)
   - `REQUIRE_BYOK` — `true` (default) makes users connect their own
     Anthropic/E2B keys at `/settings/keys` before the engine will run on
     their behalf. Flip to `false` only after you've enabled platform
     billing — when on, users with no key see a "connect your key" gate
     instead of silently spending the platform key

3. **Run the database migrations**

   Apply every SQL file in `supabase/migrations/` in order:

   - `0001_init.sql` — core tables (projects, specs, builds, audit_log)
   - `0002_spec_extraction.sql` — open_questions + feedback columns on specs
   - `0003_planner.sql` — `plans` table for the build planner
   - `0004_codegen.sql` — `build_files` + `builds.plan_id` for codegen
   - `0005_sandbox.sql` — `sandbox_runs` table for the sandbox layer
   - `0006_github.sql`  — `connections` table for OAuth credentials
   - `0007_vercel.sql`  — `deployments` table for Vercel deploy attempts
   - `0008_runtime.sql` — `agent_runtimes` + `runs` for 24/7 runtimes
   - `0009_governance.sql` — cost ledger, budgets, kill switches + **RLS
     policies on every user-scoped table** + `user_id` migrated to UUID
   - `0010_byok.sql` — `connections.key_last4` + `cost_events.key_source`
     for the bring-your-own-key path

   Either paste each file into the Supabase SQL editor, or run them through
   the Supabase CLI:

   ```bash
   supabase db push
   ```

4. **Start the dev server**

   ```bash
   npm run dev
   ```

   Open <http://localhost:3000>.

## What you should see

- A dark space environment with a slowly rotating amber-glow icosahedron at
  the centre, wrapped in a drifting cyan particle lattice.
- A glassmorphic intake panel floating in front of it, with a textarea and
  a "Forge it" button.
- Focusing the textarea brightens the Core; submitting it persists a
  project + spec + audit log row and routes you to `/projects/[id]`.
- `/projects` lists everything you've forged so far.

## Robustness

The 3D layer is **lazy-loaded client-side only**. On mount the app checks
for WebGL support and `prefers-reduced-motion`; if either fails, it
renders a static, branded 2D fallback shell with identical functionality.
Renderer DPR is capped at 2, particle count is halved on small viewports,
postprocessing is disabled on phones, and the render loop pauses when the
tab is hidden. Geometries and materials are disposed on unmount.

All interactive UI is plain DOM — no inputs trapped inside the canvas,
keyboard navigation works everywhere.

## Project layout

```
app/
  layout.tsx          ← persistent <ForgeScene/> + header/nav
  page.tsx            ← intake (/)
  projects/
    page.tsx          ← list (/projects)
    [id]/page.tsx     ← detail (/projects/[id])
  api/projects/route.ts  ← POST creates project + spec + audit row

components/
  ForgeScene.tsx      ← capability check, mounts world or fallback
  ForgeWorld.tsx      ← <Canvas> + scene assembly (client only)
  FallbackShell.tsx   ← 2D branded backdrop for no-WebGL / reduced-motion
  GlassPanel.tsx      ← reusable glassmorphic container
  IntakeForm.tsx      ← textarea + submit, drives core state
  three/
    ForgeCore.tsx     ← reactive icosahedron + emissive shell
    ParticleLattice.tsx
    PostFX.tsx

lib/
  supabase.ts         ← typed browser + server clients
  types.ts            ← Database row types
  store.ts            ← zustand store (coreState, webglReady)
  webgl.ts            ← capability + reduced-motion + viewport checks
  engine/
    llm.ts            ← server-only Anthropic SDK wrapper (usage capture)
    spec/             ← ✅ shipped: prompt → validated AgentSpec, review gate
    planner/          ← ✅ shipped: spec → grounded BuildPlan, approve gate
    codegen/          ← ✅ shipped: plan → scaffold + LLM source, static-checked
    sandbox/          ← ✅ shipped: isolated install + build + mocked smoke
    integrations/     ← ✅ shipped: GitHub push + Vercel deploy
    runtime/          ← ✅ shipped: 24/7 cron-driven runtimes
    governance/      ← ✅ shipped: cost ledger, budgets, kill switches

lib/auth.ts                  ← Supabase Auth: requireUser, requireProjectOwnership
middleware.ts                ← auth gate + session refresh
app/sign-in                  ← magic-link sign-in
app/auth/callback            ← Supabase Auth callback
app/governance               ← the control room (spend, budgets, kill switch)

supabase/migrations/
  0001_init.sql              ← core tables
  0002_spec_extraction.sql   ← open_questions + feedback on specs
  0003_planner.sql           ← plans table
  0004_codegen.sql           ← build_files + builds.plan_id
  0005_sandbox.sql           ← sandbox_runs table
  0006_github.sql            ← connections table
  0007_vercel.sql            ← deployments table
  0008_runtime.sql           ← agent_runtimes + runs
  0009_governance.sql        ← cost_events + budgets + kill_switches + RLS
  0010_byok.sql              ← connections.key_last4 + cost_events.key_source

vercel.json                  ← cron config (* * * * * → /api/runtime/tick)
```

## Scripts

| command           | what it does                          |
| ----------------- | ------------------------------------- |
| `npm run dev`     | start the local dev server            |
| `npm run build`   | production build                      |
| `npm run start`   | run the production build              |
| `npm run lint`    | next/eslint                           |
| `npm run typecheck` | strict TypeScript pass              |

## Spec extraction (live)

From a project detail page (`/projects/[id]`), hit **Generate spec**:

1. The extractor (`lib/engine/spec`) prompts Claude with the raw intent and
   asks for a strict JSON `AgentSpec` plus up to 3 clarifying questions.
2. The response is parsed and validated against the Zod schema. One repair
   retry runs if validation fails.
3. If there are clarifying questions, the spec status becomes
   `needs_clarification` and the UI renders an answer form; submitting runs a
   second pass.
4. Otherwise the status is `awaiting_review`. The UI renders the spec with
   **Confirm** / **Refine** controls. Refine accepts a free-text correction
   and runs another pass; Confirm locks the spec.
5. Every step writes to `audit_log` with token usage attached — the future
   cost-governance layer reads this.

The planner is gated on `specs.status = 'confirmed'`.

## Build planner (live)

Once a spec is confirmed, the project detail page shows a **Generate plan**
action:

1. The planner (`lib/engine/planner`) feeds the spec + the static tool
   registry to Claude and asks for a strict JSON `BuildPlan`.
2. Every capability is grounded against the registry — anything that doesn't
   map shows up as `unsupported` plus a warning. Hallucinated tool ids and
   env keys are rejected by `validatePlanTools`.
3. The task graph is validated for unique ids, valid references, and
   acyclicity (Kahn topological sort). One repair retry runs on failure.
4. The plan renders as scaffold + target + tools (with status pills) +
   planned files + env + a layered task DAG + estimate + warnings.
5. **Approve** locks the plan and moves the project to `plan_approved`;
   **Refine** accepts a free-text correction and runs another planning pass.
6. Audit-log rows: `plan.generated` (model + attempts + usage + tool
   coverage), `plan.approved`, `plan.failed`.

The codegen layer is gated on `plans.status = 'approved'`.

## Codegen (live)

Once a plan is approved, **Generate code** appears below the plan:

1. Codegen (`lib/engine/codegen`) deterministically materialises the
   `agent-node-tool-using` scaffold — package.json, tsconfig, runtime
   harness, and the tool library (web_search, http_request, llm_completion,
   file_read, file_write, schedule, plus needs_key stubs for email_read /
   email_send).
2. For every file in `plan.files` not covered by the scaffold, Claude is
   asked to write **only** that file's contents, with the tool library's
   TypeScript interface pinned into the prompt. The model is forbidden from
   reimplementing tools or inventing tool ids.
3. Each generated file passes through `staticCheckFile()` — `esbuild.transform`
   for `.ts/.tsx/.js/.jsx/.mjs/.cjs`, `JSON.parse` for `.json`. **Parse only,
   never execute.** One repair retry on failure with the esbuild error fed
   back; if still broken, the file is stored with a `static_check: failed`
   badge and surfaced as a warning.
4. All files (scaffold + generated) are persisted to `build_files`. The
   `builds` row carries per-file static-check status in its `logs` JSON.
5. The UI shows a file-tree explorer + read-only viewer with light TS/JSON
   syntax highlighting; scaffold and generated files are tagged distinctly,
   and any completeness warnings are surfaced prominently.

**Security boundary**: codegen never executes, evals, or imports the
generated code. The sandbox is the first layer allowed to run those bytes.

## Sandbox (live)

Once code is generated, **Run sandbox test** appears below the file viewer:

1. The runner (`lib/engine/sandbox`) selects a provider via
   `SANDBOX_PROVIDER` (default `e2b` — purpose-built for AI-generated code).
2. A fresh sandbox is created and the build files are written into it. The
   runner also writes a synthesised `forge_smoke.mjs` driver.
3. **Install** runs `npm install` (hard timeout 120s).
4. **Build** runs `npx tsc --noEmit` — the *real* type check that catches
   what the cheap static check missed (hard timeout 90s).
5. **Smoke** runs the driver under tsx with `FORGE_MOCK_TOOLS=1` and
   `FORGE_NETWORK_DISABLED=1`. The scaffold tool library short-circuits to
   canned data, so no real network call ever happens. Synthetic input is
   chosen per trigger (chat / api / schedule / webhook). 15–25s timeout.
6. The sandbox is **always destroyed** in a `finally` block, even on
   exception or timeout. `destroy()` is best-effort and never throws.
7. Results land in `sandbox_runs` (status, build_ok, smoke_ok, logs,
   duration, error). The build moves to `tested` or `test_failed`.

**Never reaches the sandbox**: platform DB credentials, real Anthropic
keys, the E2B key, or any other Forge env. The runner only injects
`NODE_ENV`, `CI`, and the two `FORGE_*` flags.

A second test for the same build is refused while one is `running` (with
a 15-minute zombie reaper). Audit emissions: `build.test_started`,
`build.test_passed`, `build.test_failed`.

## GitHub integration (live)

Once a build is `tested`, an **authorisation gate** appears with the exact
action the user is about to authorise:

1. If GitHub isn't connected, the gate is preceded by a **Connect GitHub**
   step that runs the OAuth flow (`/api/connections/github/start` →
   GitHub → `/api/connections/github/callback`). The token is encrypted
   at rest with AES-256-GCM (`lib/crypto.ts`) and is **never** sent to the
   browser or written to logs.
2. The gate spells out the proposed repo name, the account login, the
   file count, and the branch. The Approve button is the only path; the
   server requires `{ "authorized": true }` in the POST body — no silent
   or replayable approval.
3. The push runs server-side via Octokit and the Git Data API: create a
   PRIVATE repo (with collision-suffix name resolution), then upload
   every file as ONE initial commit (blobs → tree → commit → ref). If
   GitHub ever returns a public repo despite the private flag, the push
   aborts hard.
4. On success the build moves to `pushed` with `repo_url` populated; on
   failure to `push_failed`, with the gate re-shown so the user can
   explicitly re-approve.

Audit emissions: `connection.github_linked`, `repo.create_authorized`
(actor=user, written before the action), `repo.created`,
`repo.push_completed`, `repo.push_failed`.

## Vercel deploy (live)

Once a build is `pushed`, the second human authorisation gate appears.

**Routing**: if `plan.runtime_impl === 'always_on'` or `spec.trigger ===
'schedule'`, the build is **not** deployed via the on-demand Vercel path
— a clear panel routes it to the runtime stage (next commit) and leaves
status at `pushed`.

For on-demand agents:

1. If Vercel isn't connected, the UI shows a two-track Connect step:
   the OAuth integration (preferred, when `VERCEL_OAUTH_CLIENT_ID` /
   `VERCEL_INTEGRATION_SLUG` are configured) or a Personal Access Token
   paste flow. Both store the token encrypted at rest.
2. If `plan.env_required` is non-empty, a secrets-entry step collects the
   values in masked inputs. Required secrets must be filled; optional
   plain values are allowed empty.
3. The authorisation gate states the exact action: account, project name,
   file count, framework, and a summary of how many env keys are being
   set (NOT values). Approve is the only path; the server requires
   `{ "authorized": true }` in the POST body.
4. Server-side: ensure project → wipe + set env → upload files (SHA-1
   manifest via `/v2/files`) → create production deployment → poll
   `/v13/deployments/{id}` until `READY` / `ERROR` / timeout.
5. On `READY`: `build.status = 'deployed'`, `build.deploy_url` populated,
   `deployments` row updated with `project_ref`, `deployment_id`, `url`,
   `env_keys` (KEY NAMES ONLY). The UI shows a prominent live-URL panel.
6. On `ERROR` / timeout: `build.status = 'deploy_failed'`, build-log tail
   captured for the UI. Retry requires re-entering secrets and
   re-approving the gate — no silent retry.

**Token + secret hygiene**:
- The Vercel token is AES-256-GCM encrypted at rest, decrypted only into
  the Octokit-equivalent in-memory client during a deploy.
- Secret env VALUES never appear in any Forge table or log line; only
  KEY NAMES are persisted (`deployments.env_keys`).
- The live URL is public by design — add per-agent access control in
  the agent handler if needed.

Audit emissions: `connection.vercel_linked`, `deploy.authorized`
(actor=user, written before the action), `deploy.created`,
`deploy.completed`, `deploy.failed`.

## Runtime (live)

For always-on / scheduled agents (deferred by deploy):

1. **Activate** opens a configure step (cron expression with a human
   summary, max run time, optional secret env values) followed by the
   **third authorisation gate**: "Activate `<name>` to run automatically
   on `<cadence>`? It will execute on its own and may incur usage."
2. Approval encrypts the env with `APP_ENC_KEY` and writes an
   `agent_runtimes` row with `status='active'`. The build moves to
   `running`.
3. Vercel Cron hits `/api/runtime/tick` every minute (configured in
   `vercel.json`, secured by `CRON_SECRET`). The scheduler picks due
   runtimes (oldest `next_run_at` first), respects global + per-runtime
   concurrency caps, and executes each in a fresh isolated sandbox with
   real tools and the decrypted env.
4. Each run writes a `runs` row with status, duration, captured logs,
   output, and (on failure) the error. The UI shows recent runs with
   expandable logs.
5. **Auto-pause**: 3 consecutive failures flip the runtime to `errored`
   so a broken agent never loops forever. **Resume** resets the counter.
   **Pause** / **Stop** / **Run now** are explicit user clicks.

V1 is honestly *periodic* execution per tick — not truly persistent
long-lived processes. Documented in `lib/engine/runtime/README.md`.

Audit emissions: `runtime.activated`, `runtime.paused`, `runtime.resumed`,
`runtime.stopped`, `run.started`, `run.succeeded`, `run.failed`,
`runtime.auto_paused`.

## Security & cost governance (live)

This is the safety wall around everything. **Fail-closed**: if a guard
check errors, the action is blocked.

- **Per-user auth** via Supabase Auth (magic link). `middleware.ts`
  redirects unauthenticated users to `/sign-in`. `lib/auth.ts` exposes
  `requireUser()` and `requireProjectOwnership()`.
- **Row Level Security** is enabled on every user-scoped table
  (projects, specs, plans, builds, build_files, connections, deployments,
  agent_runtimes, runs, sandbox_runs, audit_log, cost_events, budgets,
  kill_switches). The service role bypasses RLS by design; route handlers
  also check ownership explicitly as belt-and-suspenders.
- **The guard** lives in `lib/engine/governance/guard.ts`. Every LLM call,
  sandbox run, runtime tick, and cost-incurring action route passes
  through `assertAllowed({ user_id, project_id?, projectedCostUsd? })`.
- **Cost ledger** in `cost_events` — one row per LLM/sandbox/runtime
  event with USD amount computed from `lib/engine/governance/pricing.ts`
  (current-rate placeholders; override via env).
- **Budgets** (daily / monthly, hard cap). The guard blocks new actions
  when projected spend + current spend would exceed the cap.
- **Auto-pause on budget hit** — scheduled runtimes flip to `errored`
  with audit `runtime.budget_paused` instead of looping forever.
- **Kill switch** at `global` / `user` / `project` scope. The dashboard
  surfaces it as a prominent one-click control (with confirm). When the
  global switch is engaged, the cron scheduler exits without executing,
  every new cost-incurring action returns `503 system paused`, and the
  Forge Core dims to deep red until cleared.

The control room lives at `/governance` — spend meters vs cap, budget
controls, the kill switch, active runtimes, the cost ledger, and the
audit trail.

### Pre-auth data note

This commit migrated `user_id` columns from text to UUID. Pre-existing
rows with non-UUID `user_id` (the `'forge-default'` placeholder from
earlier commits) become NULL after the migration and won't be visible
through RLS. New projects + connections are stamped with the
authenticated user's UUID.

## The unified journey (live · Phase 1 cohesion)

Every project rides a single 8-stage journey: **Intent → Spec → Plan →
Code → Sandbox → Repo → Deploy → Live (/Runtime)**. The same model
drives every UI surface:

- `lib/journey.ts` derives stage status (done / current / pending /
  failed / skipped / blocked) from raw rows. **No other module computes
  status.**
- `components/three/JourneyPipeline.tsx` renders the journey inside the
  persistent ForgeScene: 8 glow-nodes along a conduit fed by the Forge
  Core, with particle flow that stops at the current stage. Failed
  stages flare rose-red.
- `components/journey/JourneyStepper.tsx` is the 2D fallback when WebGL
  is off or `prefers-reduced-motion` is set — identical states.
- `components/journey/JourneyOverlay.tsx` is the labelled strip that
  always renders so stage names are readable regardless of mode.
- `components/journey/JourneyBridge.tsx` pushes the page's journey into
  the zustand store and triggers a Core eruption the first time the
  agent goes live.

### Streaming

Heavy LLM steps stream phase + log events via SSE (`lib/stream/sse.ts`
server, `useEventStream()` client), rendered by
`components/stream/StreamConsole.tsx`. The spec/generate flow is the
template; the streaming variant lives at
`/api/projects/[id]/spec/generate/stream` and the panel **prefers stream,
falls back to polling** on any failure. Secrets and tokens never appear
in any stream event.

### Agent dashboard

When the journey reaches Live, `components/dashboard/AgentDashboard.tsx`
takes over the top of the project page: name + goal + description from
the spec, the live URL (on-demand) or runtime status + recent runs
(always_on / scheduled), repo link, and **cost-to-date** for the project
via `getProjectSpend`.

### Governance — final coverage

Phase 1 closes the loop. Every cost-incurring or autonomous route now
runs through `lib/route-guard.ts` which composes
`requireUser → requireProjectOwnership → assertAllowed`. Every
`complete()` LLM call threads a `GovernanceScope` so cost attributes to
the right user/project. After this commit **no route bypasses the
guard**, no LLM call is unattributed, and the streaming infrastructure
inherits the same coverage.

## BYOK — Bring Your Own Key (live)

The Forge runs on the user's own Anthropic and E2B keys. Users connect
them at `/settings/keys` (paste-and-validate, AES-256-GCM at rest, only
the last 4 chars displayed). Every cost-incurring path resolves the key
through `lib/engine/keys.ts`:

1. **resolveKey(userId, provider)** returns either the user's connected
   BYOK key (`source: 'byok'`) or the platform env key
   (`source: 'platform'`). When `REQUIRE_BYOK=true` (the default) and
   the user has no connected key, it throws **NeedsKeyError** instead of
   silently falling back — the founder-protecting flag that keeps you
   from burning test credits before the platform-billing path exists.
2. **complete()** (LLM), the sandbox runner, and the runtime executor
   all pass `keySource` to `assertAllowed()`. The kill switch + ownership
   + fail-closed posture still apply; **only the budget cap is skipped
   for BYOK** (their fuel, their bill).
3. **cost_events** records `key_source` on every row so the dashboard
   can distinguish platform-paid usage from BYOK usage.
4. **NeedsKeyError** surfaces in UI as the friendly `NeedsKeyGate`
   component — links to `/settings/keys` instead of an error toast.

API: `GET/POST/DELETE /api/connections/keys`. Audit emissions:
`connection.key_added` and `connection.key_removed` carry only the
provider + `key_last4` — never the full key.

What is **NOT** in this commit (purple "later" path on the diagram):
credits, markup, Stripe, platform billing. Those land when you have
traction worth charging for.

## Next prompts will add (Phase 2)

- Cross-project ops dashboard + alerting
- Per-agent runtime escalation policies
- Per-stage 3D scenes (a dedicated view per stage)
- Token-by-token streaming via Anthropic's `messages.stream()`
- The credits / markup / Stripe platform-billing path
