// Aurexis Forge — Phase 3 (Software) per-slot codegen prompts.
//
// THIS FILE owns prompt + context assembly for the TWO LLM-driven
// slot families: ROUTE (list/create/update/delete method handlers)
// and PAGE (server-component page bodies). Auth + schema slots
// never reach this module — the slot dispatch (slots.ts) routes
// them to the deterministic scaffold + migration modules. That
// structural non-negotiable is unchanged.
//
// What changed from v1 (the blob prompt):
//
//   - SYSTEM prompts now embed the engine-owned BASE QUALITY_BAR
//     (lib/engine/codegen/quality.ts) PLUS the software addendum
//     (./quality.ts) verbatim, so we INSTRUCT against the exact
//     bar the eval harness MEASURES against.
//
//   - User messages are STRUCTURED — clearly labelled sections
//     (PURPOSE / SLOT CONTRACT / SCAFFOLD INTERFACE / LAYER /
//     SIBLING CONTRACT / WORKED EXEMPLAR) instead of a JSON dump
//     of the whole SoftwareSpec.
//
//   - Per-family WORKED EXEMPLARS: a list+create route, and a
//     server-component page. Each visibly satisfies both bars
//     (server client only, owner-pinned writes, error-handled,
//     typed, no 'use client' on pages).
//
//   - The REPAIR message keeps its shape so the static-check +
//     repair loop in slots.ts works verbatim; it now re-asserts
//     both bars.
//
// What did NOT change:
//
//   - Slot dispatch is unchanged. Auth + schema slots still never
//     reach the LLM.
//   - The deterministic RLS migration is unchanged.
//   - SCAFFOLD_INTERFACE (the surface the LLM may import from)
//     is unchanged — the service-role key remains intentionally
//     absent.
//   - Static-check is the same esbuild parse; never execute.
//   - The bounded self-heal (one repair retry) is unchanged.
//   - Governance + ledger on every complete() call.
//   - Model default: claude-sonnet-4-6.

import {
  qualityBarPromptBullets,
  QUALITY_BAR_VERSION,
} from '@/lib/engine/codegen/quality';
import type { SoftwareSpec } from '../spec';
import {
  softwareAddendumPromptBullets,
  SOFTWARE_ADDENDUM_VERSION,
} from './quality';
import { SCAFFOLD_INTERFACE } from './scaffold';

// ===========================================================================
// SYSTEM PROMPTS — one per family, built once at module load.
// ===========================================================================

/**
 * Shared prefix every family system prompt opens with. Keeps the
 * base bar text identical across route + page so improvements
 * cascade without per-family edits.
 */
function baseQualityHeader(): string {
  return (
    'BASE QUALITY BAR (engine v' +
    QUALITY_BAR_VERSION +
    ') — your output MUST satisfy every one of these; the harness measures against the same criteria:\n' +
    qualityBarPromptBullets()
  );
}

function softwareAddendumHeader(family: 'route' | 'page'): string {
  return (
    'SOFTWARE ADDENDUM (v' +
    SOFTWARE_ADDENDUM_VERSION +
    ') — additional bars for ' +
    (family === 'route' ? 'API ROUTE handlers' : 'PAGE components') +
    ':\n' +
    softwareAddendumPromptBullets(family)
  );
}

// ---------------------------------------------------------------------------
// ROUTE SYSTEM PROMPT
// ---------------------------------------------------------------------------
export const ROUTE_SYSTEM_PROMPT: string = (() => {
  const role =
    'You are the Aurexis Forge SOFTWARE ROUTE generator. You generate the BODY of ONE HTTP method handler in a Next.js (App Router) + Supabase project. Treat this file as code that will SHIP. The project\'s package.json, tsconfig, Supabase clients, middleware, and Supabase Auth integration are already scaffolded — you MUST use them, never reimplement them.';

  const outputRules =
    'OUTPUT RULES — non-negotiable:\n' +
    '- Output ONLY the file contents. No prose. No markdown code fences. No commentary.\n' +
    "- Begin with the very first character of the file (e.g. `import`, `{`, `//`).\n" +
    "- Do not include the file path; do not include a \"Here is the file:\" preamble.\n" +
    '- Do NOT include TODO / FIXME / XXX comments anywhere — see the BASE QUALITY BAR above.';

  const exportShape =
    'EXPORT SHAPE — non-negotiable for routes:\n' +
    '- Export a NAMED async function for the slot\'s HTTP method: GET / POST / PATCH / DELETE.\n' +
    '- Signature: `export async function METHOD(request: Request, context?: { params: Record<string, string> }): Promise<Response>`.\n' +
    '- Return `Response.json(body, { status })` (or `NextResponse.json`) with explicit status codes (200 / 201 / 400 / 403 / 404 / 500).\n' +
    '- NEVER write auth code. NEVER decode JWTs. NEVER touch cookies directly. The middleware has authed the request before your handler runs.\n' +
    '- NEVER reference SUPABASE_SERVICE_ROLE_KEY. There is no service-role client in this project.';

  return [
    role,
    '',
    baseQualityHeader(),
    '',
    softwareAddendumHeader('route'),
    '',
    outputRules,
    '',
    exportShape,
  ].join('\n');
})();

// ---------------------------------------------------------------------------
// PAGE SYSTEM PROMPT
// ---------------------------------------------------------------------------
export const PAGE_SYSTEM_PROMPT: string = (() => {
  const role =
    'You are the Aurexis Forge SOFTWARE PAGE generator. You generate the BODY of ONE Next.js (App Router) page in a project with Supabase + middleware-based auth already wired. Treat this file as code that will SHIP. Use the scaffold; never reimplement auth, middleware, or the supabase client.';

  const outputRules =
    'OUTPUT RULES — non-negotiable:\n' +
    '- Output ONLY the file contents. No prose. No markdown code fences. No commentary.\n' +
    "- Begin with the very first character of the file (e.g. `import`).\n" +
    "- Do not include the file path; do not include a preamble.\n" +
    '- Do NOT include TODO / FIXME / XXX comments anywhere.';

  const exportShape =
    'EXPORT SHAPE — non-negotiable for pages:\n' +
    '- Default-export an async React component. Server component by default — no `\'use client\'` directive.\n' +
    '- Query the database in the component body via `createServerClient()`. RLS scopes results to the signed-in user.\n' +
    '- Type any props minimally (most pages take no props). Render plain semantic HTML.\n' +
    '- NEVER write auth code. NEVER add `\'use client\'` in this codegen pass. NEVER import `@/lib/supabase/browser`.';

  return [
    role,
    '',
    baseQualityHeader(),
    '',
    softwareAddendumHeader('page'),
    '',
    outputRules,
    '',
    exportShape,
  ].join('\n');
})();

// ===========================================================================
// ROUTE USER MESSAGE — structured per-slot context.
// ===========================================================================

export interface RouteUserMessageArgs {
  spec: SoftwareSpec;
  entityName: string;
  tableName: string;
  fields: ReadonlyArray<{ name: string; type: string }>;
  slotKind:
    | 'list_route'
    | 'create_route'
    | 'get_route'
    | 'update_route'
    | 'delete_route';
  filePath: string;
}

export function buildRouteUserMessage(args: RouteUserMessageArgs): string {
  return [
    routePurposeSection(args),
    routeSlotContractSection(args),
    routeScaffoldSection(),
    routeLayerSection(args),
    routeSiblingContractSection(args),
    routeExemplarSection(),
    routeFinalInstruction(args),
  ].join('\n\n');
}

function routePurposeSection(args: RouteUserMessageArgs): string {
  const method = SLOT_METHOD[args.slotKind];
  return [
    'PURPOSE',
    '  This file: ' + args.filePath,
    '  HTTP method: ' + method,
    '  Project goal: ' + args.spec.goal,
    '  Plain-English intent: ' +
      SLOT_PURPOSE[args.slotKind](args.entityName, args.tableName),
  ].join('\n');
}

function routeSlotContractSection(args: RouteUserMessageArgs): string {
  const fieldLines = args.fields.map(
    (f) => '    - ' + f.name + ' :: ' + f.type,
  );
  return [
    'SLOT CONTRACT — target entity:',
    '  entity: ' + args.entityName,
    '  table:  ' + args.tableName,
    '  fields (excluding owner_id, id, created_at — the migration adds those):',
    ...fieldLines,
    '  method semantics:',
    SLOT_SEMANTIC_DETAIL[args.slotKind](args.entityName, args.tableName),
  ].join('\n');
}

function routeScaffoldSection(): string {
  return [
    'SCAFFOLD INTERFACE (the only modules you may import from this project — exact contract):',
    SCAFFOLD_INTERFACE.trim(),
  ].join('\n');
}

function routeLayerSection(args: RouteUserMessageArgs): string {
  return [
    'LAYER',
    "  This file is in the 'api' layer of the four-layer software template (schema -> api -> ui -> auth).",
    '  Files in the api layer are SERVER-ONLY route handlers. They never run in the browser. They MUST NOT import the browser supabase client or any client-only React.',
  ].join('\n');
}

function routeSiblingContractSection(args: RouteUserMessageArgs): string {
  // For routes, the relevant siblings are the OTHER method handlers on
  // the same table (collection methods at /api/<table>; item methods at
  // /api/<table>/[id]). Naming them lets the LLM match shapes (POST
  // returns the inserted row; GET-by-id returns one row; list returns an
  // array). Built from a typed map so adding get_route stays correct.
  const ALL: Array<{ kind: RouteUserMessageArgs['slotKind']; label: string }> = [
    { kind: 'list_route', label: 'GET /api/' + args.tableName + ' (list)' },
    { kind: 'create_route', label: 'POST /api/' + args.tableName + ' (create)' },
    { kind: 'get_route', label: 'GET /api/' + args.tableName + '/[id] (get-by-id)' },
    { kind: 'update_route', label: 'PATCH /api/' + args.tableName + '/[id] (update)' },
    { kind: 'delete_route', label: 'DELETE /api/' + args.tableName + '/[id] (delete)' },
  ];
  const otherSiblings = ALL.filter((s) => s.kind !== args.slotKind).map(
    (s) => s.label,
  );
  return [
    'SIBLING CONTRACT — related routes on the same table:',
    ...otherSiblings.map((s) => '  - ' + s),
    '  The codegen assembler emits a shell `route.ts` per directory that re-exports every method file. You do not need to write that shell — produce ONLY the named method handler this slot requires.',
  ].join('\n');
}

function routeExemplarSection(): string {
  return [
    'WORKED EXEMPLAR (illustrative — DO NOT COPY VERBATIM; mirror the style + quality)',
    '```',
    '// app/api/widget/_create.ts (example, NOT a file to emit)',
    "import { createServerClient } from '@/lib/supabase/server';",
    "import { currentUserId } from '@/lib/auth/roles';",
    '',
    'interface CreateWidgetBody {',
    '  readonly name: string;',
    '  readonly priority?: number;',
    '}',
    '',
    'function parseBody(payload: unknown): CreateWidgetBody | { error: string } {',
    "  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {",
    "    return { error: 'body must be a JSON object' };",
    '  }',
    '  const b = payload as Record<string, unknown>;',
    "  if (typeof b.name !== 'string' || b.name.trim().length === 0) {",
    "    return { error: 'name is required and must be a non-empty string' };",
    '  }',
    "  if (b.priority !== undefined && (typeof b.priority !== 'number' || !Number.isFinite(b.priority))) {",
    "    return { error: 'priority, when provided, must be a finite number' };",
    '  }',
    '  return { name: b.name.trim(), priority: typeof b.priority === \'number\' ? b.priority : undefined };',
    '}',
    '',
    'export async function POST(request: Request): Promise<Response> {',
    '  const userId = await currentUserId();',
    '  if (!userId) {',
    "    return Response.json({ error: 'unauthenticated' }, { status: 401 });",
    '  }',
    '',
    '  let raw: unknown;',
    '  try {',
    '    raw = await request.json();',
    '  } catch {',
    "    return Response.json({ error: 'body is not valid JSON' }, { status: 400 });",
    '  }',
    '  const parsed = parseBody(raw);',
    "  if ('error' in parsed) {",
    '    return Response.json({ error: parsed.error }, { status: 400 });',
    '  }',
    '',
    '  const supabase = createServerClient();',
    '  const { data, error } = await supabase',
    "    .from('widget')",
    '    .insert({',
    '      name: parsed.name,',
    '      priority: parsed.priority ?? null,',
    '      owner_id: userId,  // pinned server-side — never trust the client',
    '    })',
    "    .select('id, name, priority, created_at, owner_id')",
    '    .single();',
    '',
    '  if (error) {',
    '    return Response.json(',
    "      { error: 'insert failed: ' + error.message },",
    '      { status: 500 },',
    '    );',
    '  }',
    '  return Response.json(data, { status: 201 });',
    '}',
    '```',
    '',
    'Notice: validates the body shape, returns 401 when unauthed, pins owner_id to currentUserId() (never reads it from the request), maps the insert error to 500, returns the inserted row with status 201. No TODOs, no service-role, no JWT decoding.',
  ].join('\n');
}

function routeFinalInstruction(args: RouteUserMessageArgs): string {
  return [
    'GENERATE THIS FILE NOW',
    '  Path:    ' + args.filePath,
    '  Method:  ' + SLOT_METHOD[args.slotKind],
    '  Purpose: ' +
      SLOT_PURPOSE[args.slotKind](args.entityName, args.tableName),
    '',
    'Output ONLY the file contents. Begin immediately with the first character of the file. No fences. No commentary.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Slot metadata tables — kept exported as module-private but
// individually exportable so the unit test (and the prompt sections
// above) can pull from one source.
// ---------------------------------------------------------------------------

const SLOT_METHOD: Record<RouteUserMessageArgs['slotKind'], string> = {
  list_route: 'GET',
  create_route: 'POST',
  get_route: 'GET',
  update_route: 'PATCH',
  delete_route: 'DELETE',
};

const SLOT_PURPOSE: Record<
  RouteUserMessageArgs['slotKind'],
  (entity: string, table: string) => string
> = {
  list_route: (entity, table) =>
    'GET /api/' +
    table +
    ' — list rows of ' +
    entity +
    " for the signed-in user. RLS handles scoping; you simply query the table.",
  create_route: (entity, table) =>
    'POST /api/' +
    table +
    ' — parse the JSON body, validate shape, insert a row into ' +
    entity +
    ' with owner_id set to currentUserId().',
  get_route: (entity, table) =>
    'GET /api/' +
    table +
    '/[id] — fetch a single ' +
    entity +
    " row by id. RLS scopes the read to the user's own rows; return 404 when the row is absent or not owned.",
  update_route: (entity, table) =>
    'PATCH /api/' +
    table +
    '/[id] — parse the JSON body, validate shape, update the ' +
    entity +
    " row by id. RLS will refuse updates to rows the user doesn't own.",
  delete_route: (entity, table) =>
    'DELETE /api/' +
    table +
    '/[id] — delete the ' +
    entity +
    " row by id. RLS will refuse deletes for rows the user doesn't own.",
};

const SLOT_SEMANTIC_DETAIL: Record<
  RouteUserMessageArgs['slotKind'],
  (entity: string, table: string) => string
> = {
  list_route: (_entity, table) =>
    '    - SELECT from `' + table + '` (no manual where-clause for ownership; RLS scopes it).\n' +
    '    - Order by `created_at desc` unless the spec implies a different sort.\n' +
    '    - Return `Response.json(rows, { status: 200 })`.',
  create_route: (_entity, table) =>
    '    - Parse `await request.json()` and reject anything that is not a plain object.\n' +
    '    - Validate the required fields above; reject missing / wrong-type values with status 400.\n' +
    '    - Call `await currentUserId()`; reject with 401 if it returns null.\n' +
    '    - INSERT into `' + table + "` with `owner_id: userId`. NEVER read owner_id from the request body.\n" +
    '    - Return the inserted row via `.select(...).single()` with status 201.\n' +
    '    - Map insert errors to 500 with the error message in `{ error: ... }`.',
  get_route: (_entity, table) =>
    '    - Read the id from `context.params.id`; reject with 400 if missing.\n' +
    '    - SELECT * from `' + table + "` WHERE id = <id> (no manual ownership where-clause; RLS scopes it to the user's own rows).\n" +
    '    - Use `.maybeSingle()`. Return the row with status 200, or `{ error: ... }` with status 404 when it is null (absent OR not owned — RLS filtered it).\n' +
    '    - Map query errors to 500 with the error message in `{ error: ... }`.',
  update_route: (_entity, table) =>
    '    - Read the id from `context.params.id`; reject if missing.\n' +
    '    - Parse the body; validate that the supplied fields are a subset of the entity columns above.\n' +
    '    - UPDATE `' + table + "` SET <validated fields> WHERE id = <id>. Do NOT pass owner_id — RLS scopes the update to rows the user owns; passing owner_id is a privilege-escalation smell.\n" +
    '    - Return the updated row with status 200. 404 when `.select().single()` returns null after the update (RLS filtered the row out — the user does not own it).',
  delete_route: (_entity, table) =>
    '    - Read the id from `context.params.id`; reject if missing.\n' +
    '    - DELETE from `' + table + "` WHERE id = <id>. RLS scopes the delete to the user's own rows.\n" +
    '    - Return `Response.json({ ok: true }, { status: 200 })` on success. 404 when the row was already gone (no rows affected).',
};

// ===========================================================================
// PAGE USER MESSAGE — structured per-slot context.
// ===========================================================================

export interface PageUserMessageArgs {
  spec: SoftwareSpec;
  pageId: string;
  pageName: string;
  pagePurpose: string;
  /** Entities mentioned in flows that touch this page. */
  relatedEntities: ReadonlyArray<string>;
  filePath: string;
}

export function buildPageUserMessage(args: PageUserMessageArgs): string {
  return [
    pagePurposeSection(args),
    pageSlotContractSection(args),
    pageScaffoldSection(),
    pageLayerSection(),
    pageSiblingContractSection(args),
    pageExemplarSection(),
    pageFinalInstruction(args),
  ].join('\n\n');
}

function pagePurposeSection(args: PageUserMessageArgs): string {
  return [
    'PURPOSE',
    '  This file: ' + args.filePath,
    '  Page id: ' + args.pageId,
    '  Page name: ' + args.pageName,
    '  Page purpose: ' + args.pagePurpose,
    '  Project goal: ' + args.spec.goal,
  ].join('\n');
}

function pageSlotContractSection(args: PageUserMessageArgs): string {
  const related =
    args.relatedEntities.length === 0
      ? '  (no related entity inferred — pick the spec entity most relevant to the page purpose)'
      : '  related entities (the page likely reads from these tables): ' +
        args.relatedEntities.join(', ');
  // Surface flows the page participates in (by name + description) so
  // the LLM understands the user journey — not just the lone page.
  const flows = args.spec.flows.filter((f) =>
    (f.pages ?? []).includes(args.pageId),
  );
  const flowLines = flows.length === 0
    ? ['  flows touching this page: (none listed; treat as standalone)']
    : [
        '  flows touching this page:',
        ...flows.map((f) => '    - ' + f.name + ' :: ' + f.description),
      ];
  return ['SLOT CONTRACT — target page:', related, ...flowLines].join('\n');
}

function pageScaffoldSection(): string {
  return [
    'SCAFFOLD INTERFACE (the only modules you may import from this project — exact contract):',
    SCAFFOLD_INTERFACE.trim(),
  ].join('\n');
}

function pageLayerSection(): string {
  return [
    'LAYER',
    "  This file is in the 'ui' layer of the four-layer software template (schema -> api -> ui -> auth).",
    "  Pages are SERVER COMPONENTS by default. They query the database in the body via createServerClient(); RLS handles per-user scoping. Marking the file `'use client'` would push data fetching into the browser, where the only available client is the unscoped public one — DO NOT.",
  ].join('\n');
}

function pageSiblingContractSection(args: PageUserMessageArgs): string {
  // Pages CALL routes; surface the candidate route paths for each
  // related entity so the LLM can choose to fetch via `fetch()` if it
  // wants to round-trip (rare for server components, which query
  // directly via the supabase client).
  if (args.relatedEntities.length === 0) {
    return [
      'SIBLING CONTRACT',
      '  (no related entity inferred — query the spec entity most relevant to the page purpose directly via createServerClient())',
    ].join('\n');
  }
  const routePaths = args.relatedEntities.map((e) => {
    const table = pascalToTable(e);
    return '  - /api/' + table + '  (GET = list, POST = create, /[id] for PATCH/DELETE)';
  });
  return [
    'SIBLING CONTRACT — routes on the same tables (use only if you genuinely need a round-trip; server components usually query directly):',
    ...routePaths,
  ].join('\n');
}

function pageExemplarSection(): string {
  return [
    'WORKED EXEMPLAR (illustrative — DO NOT COPY VERBATIM; mirror the style + quality)',
    '```',
    '// app/(app)/widget-list/page.tsx (example, NOT a file to emit)',
    "import { createServerClient } from '@/lib/supabase/server';",
    "import { currentUserId } from '@/lib/auth/roles';",
    '',
    'interface WidgetRow {',
    '  readonly id: string;',
    '  readonly name: string;',
    '  readonly priority: number | null;',
    '  readonly created_at: string;',
    '}',
    '',
    'export default async function WidgetListPage(): Promise<JSX.Element> {',
    '  const userId = await currentUserId();',
    '  if (!userId) {',
    '    // The middleware should have redirected by now; this is a',
    '    // belt-and-braces guard rather than auth logic.',
    '    return <main><p>Sign in to view your widgets.</p></main>;',
    '  }',
    '',
    '  const supabase = createServerClient();',
    '  const { data, error } = await supabase',
    "    .from('widget')",
    "    .select('id, name, priority, created_at')",
    "    .order('created_at', { ascending: false });",
    '',
    '  if (error) {',
    '    return (',
    '      <main>',
    '        <h1>My widgets</h1>',
    '        <p>Could not load widgets: {error.message}</p>',
    '      </main>',
    '    );',
    '  }',
    '',
    '  const rows = (data ?? []) as WidgetRow[];',
    '  return (',
    '    <main>',
    '      <h1>My widgets</h1>',
    '      {rows.length === 0 ? (',
    '        <p>You have no widgets yet.</p>',
    '      ) : (',
    '        <ul>',
    '          {rows.map((row) => (',
    '            <li key={row.id}>{row.name}</li>',
    '          ))}',
    '        </ul>',
    '      )}',
    '    </main>',
    '  );',
    '}',
    '```',
    '',
    "Notice: server component (no 'use client'), createServerClient() in the body, typed row shape, error path that does NOT swallow the supabase error, friendly empty state. No TODOs, no browser client, no service-role.",
  ].join('\n');
}

function pageFinalInstruction(args: PageUserMessageArgs): string {
  return [
    'GENERATE THIS FILE NOW',
    '  Path:             ' + args.filePath,
    '  Server component: YES (no use-client)',
    '',
    'Output ONLY the file contents. Begin immediately with the first character of the file. No fences. No commentary.',
  ].join('\n');
}

// PascalCase -> snake_case table name. Mirrors migration.ts so the
// page prompt names tables the way the migration emitted them.
function pascalToTable(entity: string): string {
  return entity
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

// ===========================================================================
// REPAIR MESSAGE — shape unchanged so slots.ts runWithRepair works
// verbatim. Re-asserts BOTH bars so the fix-up call still aims at
// the same target as the first pass.
// ===========================================================================
export function buildRepairUserMessage(error: string): string {
  return [
    'esbuild rejected your previous output:',
    '',
    error,
    '',
    'Return ONLY the corrected file content. No prose. No markdown code fences. Keep the file purpose, exports, and imports intact; fix the offending lines while still meeting the BASE QUALITY BAR and the SOFTWARE ADDENDUM you were given.',
  ].join('\n');
}
