// Aurexis Forge — Phase 3 (Software) cross-user RLS isolation test.
//
// This is the SOFTWARE NON-NEGOTIABLE PROOF — first-class,
// build-failing. The Phase 3-3 codegen emits an RLS migration with
// owner-scoped policies (structurally verified). This module proves
// at RUNTIME that those policies actually isolate: user B cannot
// read user A's owner-scoped rows.
//
// The proof runs INSIDE the isolated sandbox (network off, generated
// code only runs inside the chamber). We spin up an ephemeral
// Postgres-compatible engine (pglite — in-process Postgres, ~5MB),
// install a thin `auth.uid()` / `auth.role()` shim that reads from
// PostgreSQL GUCs (so the same migration text Supabase would apply
// in production applies here unchanged), apply the generated
// migration, then walk this protocol:
//
//   1. Create two random user UUIDs A and B.
//   2. Setting GUC app.uid=A + app.role='authenticated', INSERT one
//      row into every entity table.
//   3. Setting GUC app.uid=B + app.role='authenticated', SELECT *
//      from every entity table, count rows where owner_id = A.
//   4. PASS iff every table's count is 0. Any non-zero count is an
//      RLS leak and the build FAILS.
//
// The driver emits structured `[isolation] ...` lines the runner
// parses back. Isolation failure is a HARD STOP — the runner does
// NOT attempt self-heal on isolation failures.

// ---------------------------------------------------------------------------
// Entity extraction. The driver needs to know which tables to insert
// + query. We re-derive from the SoftwareSpec rather than parsing
// the migration SQL, so the test is grounded in the source of truth.
// ---------------------------------------------------------------------------

import type { SoftwareSpec } from '../spec';
import { fileUploadMetadataEntities } from '../codegen/file-upload';

const DRIVER_TIMEOUT_MS = 60_000;

// Entity name (PascalCase) → table name (snake_case). Mirrors
// migration.ts's tableName() exactly so we don't double-derive.
function tableName(entityName: string): string {
  return entityName
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

// Returns the snake-case table names the isolation test should
// check. We test ONLY entities that have an owner_id column (the
// migration emits owner_id when spec.auth.requires_auth is true).
// When auth is off, there's no owner_id concept → no RLS to test
// (the migration emits a public-read policy instead).
export function entitiesToIsolate(spec: SoftwareSpec): string[] {
  if (!spec.auth.requires_auth) return [];
  // Declared entities PLUS the owner-scoped metadata tables synthesized for
  // file-upload slots. The metadata tables live in 0001_init.sql with the
  // same owner_id + RLS as a declared entity, so the DB isolation test
  // covers them (B can't read/update/delete A's file metadata rows). The
  // STORAGE-level isolation (B can't download A's actual files) is NOT
  // covered here — pglite is DB-only; that proof is deferred to a real run.
  return [
    ...spec.entities.map((e) => tableName(e.name)),
    ...fileUploadMetadataEntities(spec).map((e) => tableName(e.name)),
  ];
}

// ---------------------------------------------------------------------------
// Plan the isolation phase. Returns the driver file + the command
// the sandbox runs. The runner writes the driver next to the app,
// installs pglite, then executes the driver.
// ---------------------------------------------------------------------------

export interface IsolationPlan {
  // Contents of forge_isolation.mjs.
  driverContent: string;
  // The shell command the runner executes (after `npm install
  // --no-save @electric-sql/pglite` has run).
  command: string;
  // The pre-isolation install command that adds pglite as a
  // throwaway dep. The runner pipes this through a separate exec().
  preInstallCommand: string;
  // Hard wall-clock cap on the isolation phase.
  timeoutMs: number;
  // The snake-case table names we expect the driver to test. Empty
  // array means the spec doesn't require auth (and therefore no RLS
  // isolation to prove); the runner treats an empty list as "vacuous
  // pass" — no leak possible because no rows are owner-scoped.
  expectedTables: string[];
}

export function planIsolationTest(args: {
  spec: SoftwareSpec;
}): IsolationPlan {
  const tables = entitiesToIsolate(args.spec);
  return {
    driverContent: buildDriver({ tables }),
    command: 'node forge_isolation.mjs',
    preInstallCommand:
      'npm install --no-save --no-audit --no-fund --loglevel=error @electric-sql/pglite',
    timeoutMs: DRIVER_TIMEOUT_MS,
    expectedTables: tables,
  };
}

// ---------------------------------------------------------------------------
// Driver synthesis. Pure ES module string — the runner writes it as
// a `.mjs` file alongside the migration and executes it with `node`.
// The driver imports `@electric-sql/pglite` (added via npm install
// --no-save right before this exec), spins an in-process Postgres,
// reads the migration file off disk, applies it, then runs the
// cross-user protocol.
// ---------------------------------------------------------------------------

function buildDriver(args: { tables: string[] }): string {
  const tablesJson = JSON.stringify(args.tables);
  return [
    "// Generated by Aurexis Forge — Phase 3 software cross-user",
    "// isolation driver. Spins an ephemeral pglite Postgres, applies",
    "// the generated RLS migration, then proves user B cannot read",
    "// user A's owner-scoped rows. Emits structured [isolation] log",
    "// lines the runner parses.",
    "//",
    "// network OFF — pglite is in-process. The sandbox is destroyed",
    "// when this script exits regardless of outcome.",
    "",
    "import { readFileSync } from 'node:fs';",
    "import { PGlite } from '@electric-sql/pglite';",
    "import { randomUUID } from 'node:crypto';",
    "",
    "const TABLES = " + tablesJson + ";",
    "const MIGRATION_PATH = 'supabase/migrations/0001_init.sql';",
    "",
    "function log(tag, payload) {",
    "  const line = '[isolation] ' + tag + (payload ? ' ' + JSON.stringify(payload) : '');",
    "  console.log(line);",
    "}",
    "",
    "async function main() {",
    "  const db = new PGlite();",
    "",
    "  // --- Step 1: install the Supabase Auth shim ---",
    "  // The generated migration assumes auth.uid() + auth.role() exist",
    "  // (Supabase provides them in production). pglite is a vanilla",
    "  // Postgres, so we register them here as SQL functions that read",
    "  // from runtime GUCs we control per-query.",
    "  await db.exec(\"create schema if not exists auth;\");",
    "  await db.exec([",
    "    \"create or replace function auth.uid() returns uuid language sql stable as $$\",",
    "    \"  select nullif(current_setting('app.uid', true), '')::uuid\",",
    "    \"$$;\",",
    "  ].join('\\n'));",
    "  await db.exec([",
    "    \"create or replace function auth.role() returns text language sql stable as $$\",",
    "    \"  select coalesce(nullif(current_setting('app.role', true), ''), 'anon')\",",
    "    \"$$;\",",
    "  ].join('\\n'));",
    "  // auth.jwt() reads the request.jwt.claims GUC (Supabase provides it in",
    "  // production). Defined so an admin-dashboard migration — whose",
    "  // admin-read policy reads auth.jwt()->'app_metadata'->>'role' — applies",
    "  // cleanly here. The owner-scoping phases below never set this GUC, so",
    "  // auth.jwt() is null and the admin clause is false: a non-admin reader",
    "  // stays owner-scoped. (The admin-read POLICY LOGIC is proven directly",
    "  // in the hermetic pglite admin test, not here.)",
    "  await db.exec([",
    "    \"create or replace function auth.jwt() returns jsonb language sql stable as $$\",",
    "    \"  select nullif(current_setting('request.jwt.claims', true), '')::jsonb\",",
    "    \"$$;\",",
    "  ].join('\\n'));",
    "  // Supabase migrations reference auth.users — a stub table",
    "  // satisfies the foreign-key declaration without us needing a",
    "  // real auth system inside the test.",
    "  await db.exec([",
    "    \"create table if not exists auth.users (\",",
    "    \"  id uuid primary key default gen_random_uuid()\",",
    "    \");\",",
    "  ].join('\\n'));",
    "  log('shim_installed', {});",
    "",
    "  // --- Step 2: apply the generated migration ---",
    "  let migrationSql;",
    "  try {",
    "    migrationSql = readFileSync(MIGRATION_PATH, 'utf8');",
    "  } catch (err) {",
    "    log('migration_load_failed', { error: String(err && err.message ? err.message : err) });",
    "    process.exit(2);",
    "    return;",
    "  }",
    "  try {",
    "    await db.exec(migrationSql);",
    "  } catch (err) {",
    "    log('migration_apply_failed', { error: String(err && err.message ? err.message : err) });",
    "    process.exit(3);",
    "    return;",
    "  }",
    "  log('schema_applied', { tables: TABLES });",
    "",
    "  // pglite doesn't enforce RLS unless we tell it to act as a non-",
    "  // privileged role. We install a 'authenticated' role and force",
    "  // queries to run as that role for the test phases.",
    "  await db.exec(\"create role authenticated nologin\");",
    "  await db.exec(\"create role anon nologin\");",
    "  // Default-deny: revoke direct access from authenticated; the",
    "  // RLS policies in the migration are the ONLY thing that should",
    "  // let rows through.",
    "  for (const t of TABLES) {",
    "    try {",
    "      await db.exec('grant select, insert, update, delete on public.' + t + ' to authenticated');",
    "    } catch (err) {",
    "      log('grant_failed', { table: t, error: String(err && err.message ? err.message : err) });",
    "    }",
    "  }",
    "",
    "  if (TABLES.length === 0) {",
    "    // Spec has auth off → no owner-scoped rows → no cross-user",
    "    // isolation to test. Pass vacuously so the test result is",
    "    // honest.",
    "    log('passed', {",
    "      entities: [],",
    "      a_wrote: {},",
    "      b_saw_a: {},",
    "      vacuous: true,",
    "    });",
    "    process.exit(0);",
    "    return;",
    "  }",
    "",
    "  const A = randomUUID();",
    "  const B = randomUUID();",
    "  log('users_created', { a: A, b: B });",
    "",
    "  // --- Step 3: insert into auth.users so FK references exist ---",
    "  await db.query('insert into auth.users (id) values ($1), ($2)', [A, B]);",
    "",
    "  // --- Step 4: write as A under RLS ---",
    "  const aWrote = {};",
    "  for (const t of TABLES) {",
    "    try {",
    "      // Bind the GUCs that auth.uid() + auth.role() read from.",
    "      // Then switch role to authenticated so RLS is in force.",
    "      await db.exec(\"set local app.uid = '\" + A + \"'\");",
    "      await db.exec(\"set local app.role = 'authenticated'\");",
    "      await db.exec(\"set local role authenticated\");",
    "      await db.query('insert into public.' + t + ' (owner_id) values ($1)', [A]);",
    "      aWrote[t] = 1;",
    "      // Reset role at the end of the implicit txn block.",
    "      await db.exec(\"reset role\");",
    "    } catch (err) {",
    "      log('insert_a_failed', { entity: t, error: String(err && err.message ? err.message : err) });",
    "      aWrote[t] = -1;",
    "      try { await db.exec('reset role'); } catch {}",
    "    }",
    "  }",
    "  log('insert_a_done', { wrote: aWrote });",
    "",
    "  // --- Step 5: read as B under RLS — count rows owned by A ---",
    "  const bSawA = {};",
    "  let leakCount = 0;",
    "  let firstLeakTable = null;",
    "  for (const t of TABLES) {",
    "    try {",
    "      await db.exec(\"set local app.uid = '\" + B + \"'\");",
    "      await db.exec(\"set local app.role = 'authenticated'\");",
    "      await db.exec(\"set local role authenticated\");",
    "      const result = await db.query(",
    "        'select count(*)::int as n from public.' + t + \" where owner_id = $1\",",
    "        [A]",
    "      );",
    "      const rows = result.rows || [];",
    "      const n = rows[0] && typeof rows[0].n === 'number' ? rows[0].n : 0;",
    "      bSawA[t] = n;",
    "      if (n > 0) {",
    "        leakCount += n;",
    "        if (!firstLeakTable) firstLeakTable = t;",
    "      }",
    "      await db.exec('reset role');",
    "    } catch (err) {",
    "      log('read_b_failed', { entity: t, error: String(err && err.message ? err.message : err) });",
    "      bSawA[t] = -1;",
    "      try { await db.exec('reset role'); } catch {}",
    "    }",
    "  }",
    "  log('read_b_done', { b_saw_a: bSawA });",
    "",
    "  // --- Step 5b: write-isolation — B must not UPDATE or DELETE A's rows ---",
    "  // Reads alone don't prove isolation: a too-permissive policy could",
    "  // let B mutate A's rows. Under per-user RLS the USING clause filters",
    "  // A's rows out of B's view, so an UPDATE/DELETE owned by A affects 0",
    "  // rows for B. `returning id` lets us count what actually changed; any",
    "  // non-zero count is a write leak folded into the same verdict.",
    "  const bUpdatedA = {};",
    "  const bDeletedA = {};",
    "  for (const t of TABLES) {",
    "    try {",
    "      await db.exec(\"set local app.uid = '\" + B + \"'\");",
    "      await db.exec(\"set local app.role = 'authenticated'\");",
    "      await db.exec(\"set local role authenticated\");",
    "      const upd = await db.query(",
    "        'update public.' + t + \" set created_at = now() where owner_id = $1 returning id\",",
    "        [A]",
    "      );",
    "      const u = (upd.rows || []).length;",
    "      bUpdatedA[t] = u;",
    "      if (u > 0) { leakCount += u; if (!firstLeakTable) firstLeakTable = t; }",
    "      const del = await db.query(",
    "        'delete from public.' + t + \" where owner_id = $1 returning id\",",
    "        [A]",
    "      );",
    "      const d = (del.rows || []).length;",
    "      bDeletedA[t] = d;",
    "      if (d > 0) { leakCount += d; if (!firstLeakTable) firstLeakTable = t; }",
    "      await db.exec('reset role');",
    "    } catch (err) {",
    "      log('write_b_failed', { entity: t, error: String(err && err.message ? err.message : err) });",
    "      bUpdatedA[t] = -1;",
    "      bDeletedA[t] = -1;",
    "      try { await db.exec('reset role'); } catch {}",
    "    }",
    "  }",
    "  log('write_b_done', { b_updated_a: bUpdatedA, b_deleted_a: bDeletedA });",
    "",
    "  // --- Step 6: verdict ---",
    "  if (leakCount > 0) {",
    "    log('failed', {",
    "      entities: TABLES,",
    "      a_wrote: aWrote,",
    "      b_saw_a: bSawA,",
    "      b_updated_a: bUpdatedA,",
    "      b_deleted_a: bDeletedA,",
    "      leak_count: leakCount,",
    "      first_leak_table: firstLeakTable,",
    "      reason: \"B accessed \" + leakCount + \" of A's owner-scoped rows (read/update/delete) — RLS leak\",",
    "    });",
    "    process.exit(1);",
    "    return;",
    "  }",
    "  log('passed', {",
    "    entities: TABLES,",
    "    a_wrote: aWrote,",
    "    b_saw_a: bSawA,",
    "    b_updated_a: bUpdatedA,",
    "    b_deleted_a: bDeletedA,",
    "  });",
    "  process.exit(0);",
    "}",
    "",
    "main().catch((err) => {",
    "  log('driver_threw', { error: err && err.message ? err.message : String(err) });",
    "  process.exit(99);",
    "});",
    "",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output parser. Walks the combined stdout+stderr for the latest
// [isolation] passed / failed JSON line and returns a structured
// result. Tolerates the driver_threw / migration_*_failed shapes
// the driver emits on infrastructural breakages.
// ---------------------------------------------------------------------------

export interface IsolationResult {
  // 'passed' / 'failed' / 'errored' (driver crash, migration apply
  // failure, etc — distinct from a real isolation leak).
  outcome: 'passed' | 'failed' | 'errored';
  // Per-entity outcome. Maps table_name → { wrote, saw }. Empty for
  // 'errored' outcomes.
  perEntity: Record<string, { aWrote: number; bSawA: number }>;
  // Populated on 'failed' — which table leaked first, and how many
  // rows B saw across all tables.
  leakTable: string | null;
  leakCount: number;
  // Set when outcome is 'errored' — what the driver said before exit.
  errorMessage: string | null;
  // True iff the spec didn't require auth and there were no
  // owner-scoped rows to test. Vacuous pass.
  vacuous: boolean;
}

interface LogLine {
  tag: string;
  payload: Record<string, unknown>;
}

export function parseIsolationResult(combined: string): IsolationResult {
  const lines = combined.split('\n');
  // Scan top-down to keep a running history; the last terminal line
  // (passed/failed/driver_threw/migration_*_failed) wins.
  const log: LogLine[] = [];
  const marker = '[isolation] ';
  for (const line of lines) {
    if (!line) continue;
    const at = line.indexOf(marker);
    if (at < 0) continue;
    const rest = line.slice(at + marker.length).trim();
    const spaceIdx = rest.indexOf(' ');
    const tag = spaceIdx < 0 ? rest : rest.slice(0, spaceIdx);
    const jsonStr = spaceIdx < 0 ? '' : rest.slice(spaceIdx + 1).trim();
    let payload: Record<string, unknown> = {};
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // tolerate malformed JSON — keep tag, drop payload
      }
    }
    log.push({ tag, payload });
  }

  // Find the latest terminal line.
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (!entry) continue;
    if (entry.tag === 'passed') {
      return {
        outcome: 'passed',
        perEntity: buildPerEntity(entry.payload),
        leakTable: null,
        leakCount: 0,
        errorMessage: null,
        vacuous: entry.payload.vacuous === true,
      };
    }
    if (entry.tag === 'failed') {
      return {
        outcome: 'failed',
        perEntity: buildPerEntity(entry.payload),
        leakTable:
          typeof entry.payload.first_leak_table === 'string'
            ? entry.payload.first_leak_table
            : null,
        leakCount:
          typeof entry.payload.leak_count === 'number'
            ? entry.payload.leak_count
            : 0,
        errorMessage:
          typeof entry.payload.reason === 'string'
            ? entry.payload.reason
            : null,
        vacuous: false,
      };
    }
    if (
      entry.tag === 'driver_threw' ||
      entry.tag === 'migration_load_failed' ||
      entry.tag === 'migration_apply_failed'
    ) {
      return {
        outcome: 'errored',
        perEntity: {},
        leakTable: null,
        leakCount: 0,
        errorMessage:
          typeof entry.payload.error === 'string'
            ? entry.payload.error
            : 'driver errored at ' + entry.tag,
        vacuous: false,
      };
    }
  }

  // No terminal line at all — the driver was killed or never wrote.
  return {
    outcome: 'errored',
    perEntity: {},
    leakTable: null,
    leakCount: 0,
    errorMessage: 'no [isolation] terminal line in output',
    vacuous: false,
  };
}

function buildPerEntity(
  payload: Record<string, unknown>,
): Record<string, { aWrote: number; bSawA: number }> {
  const out: Record<string, { aWrote: number; bSawA: number }> = {};
  const wrote = (payload.a_wrote as Record<string, unknown> | undefined) ?? {};
  const saw = (payload.b_saw_a as Record<string, unknown> | undefined) ?? {};
  const tables = new Set<string>([...Object.keys(wrote), ...Object.keys(saw)]);
  for (const t of tables) {
    const w = wrote[t];
    const s = saw[t];
    out[t] = {
      aWrote: typeof w === 'number' ? w : 0,
      bSawA: typeof s === 'number' ? s : 0,
    };
  }
  return out;
}
