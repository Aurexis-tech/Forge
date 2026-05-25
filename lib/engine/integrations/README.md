# integrations

External-system adapters. Currently: GitHub. Each adapter is a small typed
module so the rest of the engine stays vendor-neutral.

## Files

- `connections.ts` — server-only DB helpers for the `connections` table.
  Exposes:
  - `loadConnectionPublic()` — returns a token-free row safe for SSR
  - `loadConnectionWithToken()` — decrypts and returns the token; SERVER
    callers only
  - `upsertConnection()` — encrypts + writes via `lib/crypto.ts`
- `github.ts` — server-only. `pushBuildToGitHub()` creates a PRIVATE repo
  and uploads all files in one initial commit via the Git Data API
  (`blobs → tree → commit → ref`). Aborts hard if GitHub returns a public
  repo when private was requested.
- `github-name.ts` — pure `deriveRepoName()`; safe to import from client
  components for preview. Reused as the Vercel project name.
- `vercel.ts` — server-only. `deployBuildToVercel()` ensures a project,
  wipes + sets env vars (declared + user-supplied secrets), uploads files
  via `/v2/files` with `x-vercel-digest` SHA1 manifests, creates a
  production deployment via `/v13/deployments`, then polls until
  `READY`/`ERROR`/timeout. On failure it pulls the build-log tail via
  `/v2/deployments/{id}/events` so the UI can show it.

## Human-in-the-loop contract

Every action that touches the user's external accounts goes through
`components/gate/AuthorizationGate.tsx`:

1. The exact action is described in plain text up top.
2. Each consequence is enumerated as a summary row.
3. The Approve button is the only path forward; Cancel never acts.
4. The route requires `{ authorized: true }` in the body — there is no
   silent / cookie-only / replayable approval path.
5. The route re-checks `builds.status === 'tested'` (or `'push_failed'`
   for retry) before doing anything.
6. The audit log records the authorisation **before** the action and the
   outcome after.

## Token security

- Plaintext tokens are NEVER stored. The DB column is
  `token_encrypted text` and holds an AES-256-GCM ciphertext (per
  `lib/crypto.ts`).
- Tokens are NEVER returned in an API response. The only path they take
  outside of the DB is: `decryptSecret` → in-memory `Octokit` constructor.
- Tokens are NEVER logged. The audit log records `account_login` and
  `scopes`, never the token itself.
- Rotating `APP_ENC_KEY` invalidates all stored connections — users would
  have to reconnect.

## OAuth flow

```
[Browser]  ──GET /api/connections/github/start?return_to=…──▶  [Forge]
[Forge]    ──set state cookie, redirect──▶  github.com/login/oauth/authorize
[User]     ──approves on GitHub──▶  github.com → callback URL
[GitHub]   ──GET /callback?code=…&state=…──▶  [Forge]
[Forge]    ──verify state, exchange code, fetch /user──▶  github.com
[Forge]    ──upsert connection (encrypted)──▶  Supabase
[Forge]    ──redirect to return_to with ?github_connected=login──▶  [Browser]
```

The state cookie is httpOnly + sameSite=lax + 10-minute TTL. State
comparison is constant-time (`safeEqual` in `lib/crypto.ts`).

## Vercel deploy (live)

Same authorisation gate, second time. Triggered only when `build.status`
is `pushed` and the plan is on-demand. `always_on` / scheduled agents are
**deferred** to the runtime layer with a clear message.

Secret env handling:
- Required secrets are collected via a separate UI step before the gate.
- The secret values arrive in the deploy POST body alongside `authorized:true`
  and are forwarded straight to Vercel's env API.
- **Only the key NAMES are persisted** in `deployments.env_keys`. The
  values are never logged and never written to any Forge table.

`deployments.url` reflects what Vercel returned; `builds.deploy_url` is
also populated for quick lookup. The live URL is **public by design** —
add per-agent access control inside the agent handler if needed.
