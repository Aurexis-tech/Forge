// Aurexis Forge — Phase 3 (Software) slot dispatch.
//
// THIS FILE is where the THREE STRUCTURAL NON-NEGOTIABLES are enforced
// by code routing, not by prompt-asking:
//
//   1. NO HAND-ROLLED AUTH — slot kinds in AUTH_SLOTS are routed to
//      the DETERMINISTIC scaffold (resolveSoftwareScaffold). No LLM
//      call ever happens for those kinds. Even if a plan task with
//      slot.kind='session_middleware' arrives, this file ignores its
//      body intent and the assembler emits the canonical template
//      file.
//
//   2. RLS — slot kinds in SCHEMA_SLOTS are routed to the
//      DETERMINISTIC migration emit (emitSoftwareMigration). The
//      migration unconditionally enables RLS on every entity table.
//
//   3. SERVER/CLIENT BOUNDARY — the per-slot LLM call's prompt
//      surfaces ONLY the server Supabase client and the
//      template-emitted auth helpers; the browser client is
//      intentionally not in the scaffold interface the prompt
//      receives. No LLM-filled file imports the service-role key
//      because the prompt never mentions it and the prompt
//      enumerates the only allowed imports.
//
// The dispatch is exhaustive across SLOT_KINDS — adding a new slot
// kind requires a code change here, by design.

import {
  LLMError,
  CODEGEN_MODEL,
  complete,
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
import type { SlotKind } from '../planner/template';
import {
  PAGE_SYSTEM_PROMPT,
  ROUTE_SYSTEM_PROMPT,
  buildPageUserMessage,
  buildRepairUserMessage,
  buildRouteUserMessage,
} from './prompts';
import { tableName } from './migration';

// ---------------------------------------------------------------------------
// The closed slot-family map. Every SLOT_KINDS value lives in exactly
// one family. Adding a kind requires updating this map.
// ---------------------------------------------------------------------------

const ROUTE_SLOTS = new Set<SlotKind>([
  'list_route',
  'create_route',
  'update_route',
  'delete_route',
]);
const PAGE_SLOTS = new Set<SlotKind>(['page_component']);
const SCHEMA_SLOTS = new Set<SlotKind>(['entity_migration', 'rls_policy']);
const AUTH_SLOTS = new Set<SlotKind>([
  'session_middleware',
  'role_gate',
  'per_user_isolation_check',
]);

// ---------------------------------------------------------------------------
// Per-LLM-slot result shape. Schema + auth slots resolve to
// "deterministic" rather than going through the LLM path.
// ---------------------------------------------------------------------------

export class SoftwareSlotError extends Error {
  readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'SoftwareSlotError';
    this.cause = opts?.cause;
  }
}

export interface SlotFile {
  path: string;
  content: string;
  bytes: number;
  staticCheck: StaticCheckResult;
}

export type SlotResolution =
  | {
      // Deterministic — no LLM call. Files are emitted by the
      // scaffold or migration modules; the caller composes them into
      // the final build file list.
      kind: 'deterministic';
      slotKind: SlotKind;
      // Path the slot "satisfied" by the deterministic emit (e.g.
      // 'middleware.ts' for session_middleware). Purely informational.
      satisfiedBy: string;
    }
  | {
      // LLM-filled — the slot's body was generated. The caller
      // writes `file` into the build's file list (possibly merging
      // with a sibling route slot via a shell route.ts).
      kind: 'llm';
      slotKind: SlotKind;
      task: SoftwareTask;
      file: SlotFile;
      attempts: number;
      model: string;
      usage: LLMUsage;
    };

// ---------------------------------------------------------------------------
// Dispatch entry point. Routes one plan task to either the
// deterministic emit (auth + schema) or the LLM seam (routes + pages).
// ---------------------------------------------------------------------------

export interface ResolveSlotInput {
  task: SoftwareTask;
  spec: SoftwareSpec;
  plan: SoftwareBuildPlan;
  governance: GovernanceScope;
}

export async function resolveSlot(
  input: ResolveSlotInput,
): Promise<SlotResolution> {
  const { task } = input;
  const slotKind = task.slot.kind as SlotKind;

  // --- Deterministic paths (no LLM) ---------------------------------------
  // The scaffold + migration emit handles these. We just record that
  // the slot was satisfied so the assembler can audit coverage.
  if (AUTH_SLOTS.has(slotKind)) {
    return {
      kind: 'deterministic',
      slotKind,
      satisfiedBy: authSlotPath(slotKind),
    };
  }
  if (SCHEMA_SLOTS.has(slotKind)) {
    return {
      kind: 'deterministic',
      slotKind,
      satisfiedBy: 'supabase/migrations/0001_init.sql',
    };
  }

  // --- LLM paths ----------------------------------------------------------
  if (ROUTE_SLOTS.has(slotKind)) {
    return await fillRouteSlot(input);
  }
  if (PAGE_SLOTS.has(slotKind)) {
    return await fillPageSlot(input);
  }

  // Exhaustive guard — adding a new SlotKind requires updating one of
  // the sets above, which surfaces here as a loud error otherwise.
  throw new SoftwareSlotError(
    "unrecognised slot kind '" + slotKind + "'",
  );
}

function authSlotPath(slotKind: SlotKind): string {
  switch (slotKind) {
    case 'session_middleware':
      return 'middleware.ts';
    case 'role_gate':
      return 'lib/auth/roles.ts';
    case 'per_user_isolation_check':
      return 'lib/auth/rls.ts';
    default:
      throw new SoftwareSlotError('not an auth slot: ' + slotKind);
  }
}

// ---------------------------------------------------------------------------
// LLM seam — one per-method handler at a time. Mirrors
// generateOneAgentFile / generateOneSystemNodeModule architecturally:
// complete() → static check → optional repair retry → static check
// again. Same governance + ledger posture inherited via llm.complete.
// ---------------------------------------------------------------------------

async function fillRouteSlot(input: ResolveSlotInput): Promise<SlotResolution> {
  const { task, spec, governance } = input;
  const target = task.slot.target;
  if (target === null) {
    throw new SoftwareSlotError(
      "route slot '" + task.id + "' has no entity target",
    );
  }
  const entity = spec.entities.find((e) => e.name === target);
  if (!entity) {
    throw new SoftwareSlotError(
      "route slot '" +
        task.id +
        "' references unknown entity '" +
        target +
        "'",
    );
  }
  const slotKind = task.slot.kind as
    | 'list_route'
    | 'create_route'
    | 'update_route'
    | 'delete_route';
  const filePath = routeSlotPath(slotKind, target);

  const userMessage = buildRouteUserMessage({
    spec,
    entityName: target,
    tableName: tableName(target),
    fields: entity.fields,
    slotKind,
    filePath,
  });

  const result = await runWithRepair({
    systemPrompt: ROUTE_SYSTEM_PROMPT,
    userMessage,
    filePath,
    governance: {
      ...governance,
      ref:
        (governance.ref ?? 'software.codegen') +
        '.route.' +
        slotKind +
        '.' +
        target,
    },
  });

  return {
    kind: 'llm',
    slotKind,
    task,
    file: result.file,
    attempts: result.attempts,
    model: result.model,
    usage: result.usage,
  };
}

async function fillPageSlot(input: ResolveSlotInput): Promise<SlotResolution> {
  const { task, spec, governance } = input;
  const target = task.slot.target;
  if (target === null) {
    throw new SoftwareSlotError(
      "page slot '" + task.id + "' has no page target",
    );
  }
  const page = spec.pages.find((p) => p.id === target);
  if (!page) {
    throw new SoftwareSlotError(
      "page slot '" + task.id + "' references unknown page '" + target + "'",
    );
  }

  // Surface the entities flows-touching-this-page mention, so the
  // LLM picks the right tables to query. Same heuristic the planner's
  // graph derivation uses — kept inline here to avoid a cross-module
  // dependency.
  const flowText = spec.flows
    .filter((f) => (f.pages ?? []).includes(target))
    .map((f) => f.name + ' ' + f.description)
    .join(' ')
    .toLowerCase();
  const relatedEntities = spec.entities
    .filter((e) => flowText.includes(e.name.toLowerCase()))
    .map((e) => e.name);

  const filePath = 'app/(app)/' + slugifyPath(target) + '/page.tsx';

  const userMessage = buildPageUserMessage({
    spec,
    pageId: target,
    pageName: page.name,
    pagePurpose: page.purpose,
    relatedEntities,
    filePath,
  });

  const result = await runWithRepair({
    systemPrompt: PAGE_SYSTEM_PROMPT,
    userMessage,
    filePath,
    governance: {
      ...governance,
      ref: (governance.ref ?? 'software.codegen') + '.page.' + target,
    },
  });

  return {
    kind: 'llm',
    slotKind: 'page_component',
    task,
    file: result.file,
    attempts: result.attempts,
    model: result.model,
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Shared LLM-call helper. One pass + a single repair retry, identical
// shape to the Phase 1 + 2 per-file generators.
// ---------------------------------------------------------------------------

interface RunWithRepairArgs {
  systemPrompt: string;
  userMessage: string;
  filePath: string;
  governance: GovernanceScope;
}

interface RunWithRepairResult {
  file: SlotFile;
  attempts: number;
  model: string;
  usage: LLMUsage;
}

async function runWithRepair(
  args: RunWithRepairArgs,
): Promise<RunWithRepairResult> {
  let first;
  try {
    first = await complete({
      model: CODEGEN_MODEL,
      system: args.systemPrompt,
      messages: [{ role: 'user', content: args.userMessage }],
      maxTokens: 4000,
      governance: {
        ...args.governance,
        ref: (args.governance.ref ?? 'software.codegen') + '.pass1',
      },
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new SoftwareSlotError(
        "LLM error generating '" + args.filePath + "': " + err.message,
        { cause: err },
      );
    }
    throw err;
  }
  const content1 = sanitise(first.text);
  const check1 = await staticCheckFile(args.filePath, content1);
  if (check1.ok) {
    return {
      file: {
        path: args.filePath,
        content: content1,
        bytes: byteLength(content1),
        staticCheck: check1,
      },
      attempts: 1,
      model: first.model,
      usage: first.usage,
    };
  }

  // One repair retry — feed the esbuild error back.
  let repair;
  try {
    repair = await complete({
      model: CODEGEN_MODEL,
      system: args.systemPrompt,
      messages: [
        { role: 'user', content: args.userMessage },
        { role: 'assistant', content: content1 },
        { role: 'user', content: buildRepairUserMessage(check1.error) },
      ],
      maxTokens: 4000,
      governance: {
        ...args.governance,
        ref: (args.governance.ref ?? 'software.codegen') + '.repair',
      },
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new SoftwareSlotError(
        "LLM repair error for '" + args.filePath + "': " + err.message,
        { cause: err },
      );
    }
    throw err;
  }
  const content2 = sanitise(repair.text);
  const check2 = await staticCheckFile(args.filePath, content2);
  return {
    file: {
      path: args.filePath,
      content: content2,
      bytes: byteLength(content2),
      staticCheck: check2,
    },
    attempts: 2,
    model: repair.model,
    usage: sumUsage(first.usage, repair.usage),
  };
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

function routeSlotPath(
  slotKind:
    | 'list_route'
    | 'create_route'
    | 'update_route'
    | 'delete_route',
  entityName: string,
): string {
  const table = tableName(entityName);
  // Per-slot file. The assembler emits a shell `route.ts` that
  // re-exports the methods so Next.js picks them up.
  switch (slotKind) {
    case 'list_route':
      return 'app/api/' + table + '/_list.ts';
    case 'create_route':
      return 'app/api/' + table + '/_create.ts';
    case 'update_route':
      return 'app/api/' + table + '/[id]/_update.ts';
    case 'delete_route':
      return 'app/api/' + table + '/[id]/_delete.ts';
  }
}

function slugifyPath(pageId: string): string {
  // Page ids are already lower_snake_case per the spec; convert to
  // kebab-case for the URL. Mechanical.
  return pageId.replace(/_/g, '-');
}

function sanitise(text: string): string {
  let s = text;
  const trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    s = trimmed
      .replace(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
  }
  return s.endsWith('\n') ? s : s + '\n';
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ---------------------------------------------------------------------------
// Shell route.ts emit. Next.js App Router only treats `route.ts` as a
// route; the per-slot _list.ts / _create.ts files are siblings the
// shell re-exports. The shell is DETERMINISTIC — the LLM never writes
// it — so no slot can sneak in an extra method or auth shim through
// the shell.
// ---------------------------------------------------------------------------

export function buildShellRoute(args: {
  // Path of the shell route.ts (e.g. 'app/api/expenses/route.ts').
  path: string;
  // Which methods are present at this path. Each maps to a sibling
  // _list.ts / _create.ts / _update.ts / _delete.ts.
  methods: Array<'GET' | 'POST' | 'PATCH' | 'DELETE'>;
}): string {
  const lines: string[] = [];
  lines.push("// Aurexis Forge — route shell (template-emitted).");
  lines.push('//');
  lines.push("// Next.js App Router only treats route.ts as a route; the per-slot");
  lines.push("// _list.ts / _create.ts / _update.ts / _delete.ts files next to this");
  lines.push("// shell carry the actual method bodies. This shell re-exports them.");
  lines.push('');
  if (args.methods.includes('GET')) {
    lines.push("export { GET } from './_list';");
  }
  if (args.methods.includes('POST')) {
    lines.push("export { POST } from './_create';");
  }
  if (args.methods.includes('PATCH')) {
    lines.push("export { PATCH } from './_update';");
  }
  if (args.methods.includes('DELETE')) {
    lines.push("export { DELETE } from './_delete';");
  }
  lines.push('');
  return lines.join('\n');
}
