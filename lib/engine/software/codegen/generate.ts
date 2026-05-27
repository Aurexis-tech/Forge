// Aurexis Forge — Phase 3 (Software) codegen pipeline.
//
//   generateSoftwareCode(): confirmed SoftwareSpec + approved
//                            SoftwareBuildPlan → materialised
//                            scaffold + RLS migration + per-slot
//                            LLM fills + shell route.ts files,
//                            every file statically checked.
//
// HARD INVARIANT: this module NEVER executes generated code. The
// static check is esbuild.transform() only — same as Phases 1 + 2.
//
// THE THREE STRUCTURAL NON-NEGOTIABLES — enforced HERE, not by prompt:
//
//   1. NO HAND-ROLLED AUTH — the scaffold ALWAYS includes
//      middleware.ts + lib/auth/roles.ts + lib/auth/rls.ts +
//      app/sign-in/page.tsx + app/auth/callback/route.ts +
//      lib/supabase/server.ts + lib/supabase/browser.ts. No LLM
//      call ever writes to these paths; the slot dispatch in
//      slots.ts routes every auth slot kind back to the scaffold.
//
//   2. RLS ON EVERY ENTITY — the migration is emitted by
//      migration.ts walking spec.entities. Every entity gets an
//      `enable row level security` line and a `create policy`
//      line; no code path skips this.
//
//   3. SERVER/CLIENT BOUNDARY — the per-slot LLM call's prompt
//      exposes only the server Supabase client + the auth helpers.
//      The browser client is template-emitted and ONLY imported by
//      the template-emitted sign-in page. The service-role key is
//      never referenced by any generated file.

import {
  sumUsage,
  type GovernanceScope,
  type LLMUsage,
} from '@/lib/engine/llm';
import {
  staticCheckFile,
  type StaticCheckResult,
} from '@/lib/engine/codegen/staticcheck';
import type { SoftwareSpec } from '../spec';
import type {
  SoftwareBuildPlan,
  SoftwareTask,
} from '../planner/schema';
import {
  resolveSoftwareScaffold,
  SCAFFOLD_PATHS,
} from './scaffold';
import {
  emitSoftwareMigration,
  migrationPath,
  tableName,
} from './migration';
import {
  buildShellRoute,
  resolveSlot,
  SoftwareSlotError,
} from './slots';

export class SoftwareCodegenError extends Error {
  readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'SoftwareCodegenError';
    this.cause = opts?.cause;
  }
}

export interface SoftwareGeneratedFile {
  readonly path: string;
  readonly content: string;
  readonly source: 'scaffold' | 'generated';
  readonly bytes: number;
  readonly staticCheck: StaticCheckResult;
}

export interface SoftwareCodegenSummary {
  readonly files: SoftwareGeneratedFile[];
  readonly warnings: string[];
  readonly usage: LLMUsage;
  // Total LLM-attempt count across all per-slot calls (one pass +
  // optional repair retry per slot).
  readonly attempts: number;
  readonly modelsUsed: string[];
  // Slot coverage — how many of each kind we resolved + how many
  // resulted in an LLM call (the auth + schema slots count as
  // deterministic).
  readonly slotCounts: {
    readonly deterministic: number;
    readonly llm: number;
  };
  readonly perSlot: ReadonlyArray<{
    readonly taskId: string;
    readonly slotKind: string;
    // 'deterministic' rows have no path (they're satisfied by a
    // scaffold file or the migration).
    readonly path: string | null;
    readonly source: 'deterministic' | 'llm';
    readonly attempts: number;
    readonly staticCheckOk: boolean;
  }>;
  readonly llmFilesFailed: number;
  // Always 'nextjs-supabase-app' for now; future templates would key
  // off plan.template_id.
  readonly scaffoldId: string;
}

export async function generateSoftwareCode(args: {
  spec: SoftwareSpec;
  plan: SoftwareBuildPlan;
  governance: GovernanceScope;
}): Promise<SoftwareCodegenSummary> {
  const { spec, plan } = args;
  const warnings: string[] = [];

  // ---------------------------------------------------------------------
  // 1. Materialise the deterministic scaffold. This brings the three
  //    structural non-negotiables into the build BEFORE any LLM call.
  // ---------------------------------------------------------------------
  const scaffoldFiles = resolveSoftwareScaffold({
    entityNames: spec.entities.map((e) => e.name),
    perUserIsolation: spec.auth.per_user_isolation,
  });
  const scaffoldChecked: SoftwareGeneratedFile[] = [];
  for (const f of scaffoldFiles) {
    const sc = await staticCheckFile(f.path, f.content);
    if (!sc.ok) {
      warnings.push(
        "Scaffold file '" + f.path + "' failed static check — Forge bug.",
      );
    }
    scaffoldChecked.push({
      path: f.path,
      content: f.content,
      source: 'scaffold',
      bytes: byteLength(f.content),
      staticCheck: sc,
    });
  }

  // ---------------------------------------------------------------------
  // 2. Emit the RLS migration deterministically — the schema +
  //    rls_policy slot kinds are SATISFIED by this single file.
  // ---------------------------------------------------------------------
  const migrationContent = emitSoftwareMigration(spec);
  const migrationFile: SoftwareGeneratedFile = {
    path: migrationPath(),
    content: migrationContent,
    source: 'generated',
    bytes: byteLength(migrationContent),
    staticCheck: await staticCheckFile(migrationPath(), migrationContent),
  };

  // ---------------------------------------------------------------------
  // 3. Per-slot resolution. Each task routes through `resolveSlot`,
  //    which returns either {kind:'deterministic'} (no LLM) or
  //    {kind:'llm', file} (one new file). The dispatch is the single
  //    place that decides "auth/schema → template" vs "route/page →
  //    LLM".
  // ---------------------------------------------------------------------
  let totalUsage: LLMUsage = { input_tokens: 0, output_tokens: 0 };
  let totalAttempts = 0;
  let llmFilesFailed = 0;
  const modelsUsed = new Set<string>();
  const llmFiles: SoftwareGeneratedFile[] = [];
  // Mutable build-time array; the public summary field is readonly.
  const perSlot: Array<SoftwareCodegenSummary['perSlot'][number]> = [];
  // Track which methods land at which route path so the assembler
  // can emit a single shell `route.ts` per route group.
  type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
  const routeShellByPath = new Map<string, Set<Method>>();
  let deterministic = 0;
  let llm = 0;

  for (const task of plan.tasks) {
    let resolution;
    try {
      resolution = await resolveSlot({
        task,
        spec,
        plan,
        governance: args.governance,
      });
    } catch (err) {
      if (err instanceof SoftwareSlotError) {
        throw new SoftwareCodegenError(err.message, { cause: err });
      }
      throw err;
    }

    if (resolution.kind === 'deterministic') {
      deterministic++;
      // Sanity — the satisfying file must be in the scaffold OR be
      // the migration. Anything else means the dispatch lied.
      const satisfiedBy = resolution.satisfiedBy;
      const inScaffold = SCAFFOLD_PATHS.has(satisfiedBy);
      const isMigration = satisfiedBy === migrationPath();
      if (!inScaffold && !isMigration) {
        warnings.push(
          "Slot '" +
            task.id +
            "' claims to be satisfied by '" +
            satisfiedBy +
            "' but that file is neither scaffold nor migration.",
        );
      }
      perSlot.push({
        taskId: task.id,
        slotKind: resolution.slotKind,
        path: resolution.satisfiedBy,
        source: 'deterministic',
        attempts: 0,
        staticCheckOk: true,
      });
      continue;
    }

    // LLM-filled slot.
    llm++;
    totalUsage = sumUsage(totalUsage, resolution.usage);
    totalAttempts += resolution.attempts;
    modelsUsed.add(resolution.model);
    if (!resolution.file.staticCheck.ok) {
      llmFilesFailed++;
      warnings.push(
        "Slot '" +
          task.id +
          "' produced '" +
          resolution.file.path +
          "' that still failed esbuild parse after a repair retry.",
      );
    }
    llmFiles.push({
      path: resolution.file.path,
      content: resolution.file.content,
      source: 'generated',
      bytes: resolution.file.bytes,
      staticCheck: resolution.file.staticCheck,
    });
    perSlot.push({
      taskId: task.id,
      slotKind: resolution.slotKind,
      path: resolution.file.path,
      source: 'llm',
      attempts: resolution.attempts,
      staticCheckOk: resolution.file.staticCheck.ok,
    });

    // Bookkeep route shells. Each per-method slot writes to
    // `_list.ts`/`_create.ts` at `app/api/<table>/`, or to
    // `_update.ts`/`_delete.ts` at `app/api/<table>/[id]/`. We
    // collect the methods per route group so the shell route.ts
    // re-exports the right set.
    const routeMethod = routeMethodFor(task);
    if (routeMethod) {
      const groupPath = routeShellPathFor(task);
      if (!routeShellByPath.has(groupPath)) {
        routeShellByPath.set(groupPath, new Set());
      }
      routeShellByPath.get(groupPath)!.add(routeMethod);
    }
  }

  // ---------------------------------------------------------------------
  // 4. Emit shell route.ts files. Deterministic — the LLM never sees
  //    these and so cannot insert an alternative method or an auth
  //    shim. Static-check each.
  // ---------------------------------------------------------------------
  const shellFiles: SoftwareGeneratedFile[] = [];
  for (const [path, methodSet] of routeShellByPath) {
    const methods = Array.from(methodSet).sort();
    const content = buildShellRoute({ path, methods });
    const sc = await staticCheckFile(path, content);
    if (!sc.ok) {
      warnings.push("Shell route '" + path + "' failed static check — Forge bug.");
    }
    shellFiles.push({
      path,
      content,
      source: 'generated',
      bytes: byteLength(content),
      staticCheck: sc,
    });
  }

  // ---------------------------------------------------------------------
  // 5. Final assembly. Order: scaffold first (lowest layer), then
  //    migration, then LLM-filled slots, then route shells. The
  //    file order doesn't drive Next.js behaviour at all; it's
  //    purely for human review.
  // ---------------------------------------------------------------------
  const files: SoftwareGeneratedFile[] = [
    ...scaffoldChecked,
    migrationFile,
    ...llmFiles,
    ...shellFiles,
  ];

  return {
    files,
    warnings,
    usage: totalUsage,
    attempts: totalAttempts,
    modelsUsed: Array.from(modelsUsed),
    slotCounts: { deterministic, llm },
    perSlot,
    llmFilesFailed,
    scaffoldId: 'nextjs-supabase-app',
  };
}

// ---------------------------------------------------------------------------
// Per-slot regeneration seam — exposed for the Phase 3-4 sandbox
// runner's bounded self-heal. Given a slot file path the runner
// identified as the build's failure point, find the task that owns
// that path and re-run resolveSlot for that ONE task. Returns the
// new file ready to be written back into the sandbox + persisted.
//
// Only LLM-filled slots can be regenerated. Auth + schema slots are
// deterministic — a "build failure" at those paths means the
// scaffold or migration emit itself is broken, which is a Forge
// bug, not something the LLM can patch. We surface that as a hard
// stop.
// ---------------------------------------------------------------------------

export interface RegenerateSoftwareSlotResult {
  file: SoftwareGeneratedFile;
  attempts: number;
  model: string;
  usage: LLMUsage;
  // Task we re-ran (for audit + per-slot trail).
  taskId: string;
  slotKind: string;
}

export async function regenerateSoftwareSlot(args: {
  spec: SoftwareSpec;
  plan: SoftwareBuildPlan;
  // File path the runner identified as failing. Must match the path
  // some LLM-filled slot would emit; otherwise we 409 with a clear
  // message.
  filePath: string;
  governance: GovernanceScope;
}): Promise<RegenerateSoftwareSlotResult> {
  const task = findTaskForPath(args.plan, args.filePath);
  if (!task) {
    throw new SoftwareCodegenError(
      "regenerateSoftwareSlot: no LLM-filled slot owns '" +
        args.filePath +
        "'",
    );
  }
  const resolution = await resolveSlot({
    task,
    spec: args.spec,
    plan: args.plan,
    governance: {
      ...args.governance,
      ref:
        (args.governance.ref ?? 'software.codegen.selfheal') +
        '.' +
        task.id,
    },
  });
  if (resolution.kind === 'deterministic') {
    throw new SoftwareCodegenError(
      "regenerateSoftwareSlot: slot '" +
        task.id +
        "' is deterministic (auth/schema) — cannot self-heal via LLM",
    );
  }
  return {
    file: {
      path: resolution.file.path,
      content: resolution.file.content,
      source: 'generated',
      bytes: resolution.file.bytes,
      staticCheck: resolution.file.staticCheck,
    },
    attempts: resolution.attempts,
    model: resolution.model,
    usage: resolution.usage,
    taskId: task.id,
    slotKind: resolution.slotKind,
  };
}

// Walks the plan's tasks looking for one that would emit the given
// path. Mirrors the path-derivation logic in slots.ts so the seam
// stays in sync with the per-slot emit.
function findTaskForPath(
  plan: SoftwareBuildPlan,
  filePath: string,
): SoftwareTask | null {
  // Page slot path: app/(app)/<slug>/page.tsx
  const pageMatch = filePath.match(/^app\/\(app\)\/([^/]+)\/page\.tsx$/);
  if (pageMatch) {
    const slug = pageMatch[1]!;
    // Page ids are lower_snake_case; the slug is kebab-case. Reverse
    // the mechanical conversion.
    const pageId = slug.replace(/-/g, '_');
    return (
      plan.tasks.find(
        (t) => t.slot.kind === 'page_component' && t.slot.target === pageId,
      ) ?? null
    );
  }
  // Route slot paths: app/api/<table>/_list.ts (etc).
  const routeMatch = filePath.match(
    /^app\/api\/([^/]+)(?:\/\[id\])?\/_(list|create|update|delete)\.ts$/,
  );
  if (routeMatch) {
    const table = routeMatch[1]!;
    const method = routeMatch[2]!;
    const slotKind = method + '_route';
    // Reverse the table-name slugification: entity names are
    // PascalCase, tables are snake_case. We can't perfectly invert
    // (e.g. "MyExpense" → "my_expense" is unambiguous, but the
    // reverse depends on which letters are capitalised). Instead,
    // walk all entities and pick the one whose tableName matches.
    return (
      plan.tasks.find(
        (t) =>
          t.slot.kind === slotKind &&
          t.slot.target !== null &&
          taskTableMatches(t.slot.target, table),
      ) ?? null
    );
  }
  return null;
}

function taskTableMatches(entityName: string, table: string): boolean {
  return entityName
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '') === table;
}

// ---------------------------------------------------------------------------
// Helpers — route shell bookkeeping.
// ---------------------------------------------------------------------------

function routeMethodFor(
  task: SoftwareTask,
): 'GET' | 'POST' | 'PATCH' | 'DELETE' | null {
  switch (task.slot.kind) {
    case 'list_route':
      return 'GET';
    case 'create_route':
      return 'POST';
    case 'update_route':
      return 'PATCH';
    case 'delete_route':
      return 'DELETE';
    default:
      return null;
  }
}

function routeShellPathFor(task: SoftwareTask): string {
  if (task.slot.target === null) {
    throw new SoftwareCodegenError(
      "route slot '" + task.id + "' has no entity target",
    );
  }
  const table = tableName(task.slot.target);
  switch (task.slot.kind) {
    case 'list_route':
    case 'create_route':
      return 'app/api/' + table + '/route.ts';
    case 'update_route':
    case 'delete_route':
      return 'app/api/' + table + '/[id]/route.ts';
    default:
      throw new SoftwareCodegenError(
        "task '" + task.id + "' is not a route slot",
      );
  }
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
