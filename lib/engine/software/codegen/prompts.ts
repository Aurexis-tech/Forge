// Aurexis Forge — Phase 3 (Software) per-slot codegen prompts.
//
// Each slot family has its own narrow system prompt. The LLM ONLY
// sees the slot it's filling — never the surrounding scaffold, never
// the service-role key, never the browser client when generating a
// server file. The two families:
//
//   1. ROUTE — list / create / update / delete handlers. Single
//      method per slot, server-side, uses the user-scoped Supabase
//      client and pins owner_id = auth.uid().
//   2. PAGE — server-component page body. Uses the user-scoped
//      Supabase client, calls the database directly (RLS enforces
//      isolation), renders typed React.
//
// Auth slots (session_middleware, role_gate, per_user_isolation_check)
// + schema slots (entity_migration, rls_policy) NEVER reach an LLM
// prompt — they're emitted deterministically by scaffold.ts +
// migration.ts. The slot-kind dispatch in slots.ts is the single
// place that decides "LLM or template".

import type { SoftwareSpec } from '../spec';
import { SCAFFOLD_INTERFACE } from './scaffold';

// ---------------------------------------------------------------------------
// ROUTE prompts — generate one HTTP method handler at a time.
// ---------------------------------------------------------------------------

export const ROUTE_SYSTEM_PROMPT =
  `You are the Aurexis Forge SOFTWARE route generator.

You generate the BODY of ONE HTTP method handler in a Next.js (App Router) + Supabase project. The project's package.json, tsconfig, Supabase clients, middleware, and Supabase Auth integration are already scaffolded — you MUST use them, never reimplement them.

OUTPUT RULES — non-negotiable:
- Output ONLY the file contents. No prose. No markdown code fences.
- Begin with the very first character of the file (e.g. \`import\`, \`{\`, \`//\`).
- Do not include the file path; do not include a "Here is the file:" preamble.

CODE RULES — non-negotiable:
- Server-only. Use ES module syntax. Local imports MUST use the \`@/\` alias (the project's tsconfig.json sets it up).
- Use ONLY \`createServerClient\` from \`@/lib/supabase/server\`. Never import the browser client. Never reach for the service-role key — it is intentionally NOT exposed by any helper.
- Use \`currentUserId\` / \`userHasAnyRole\` from \`@/lib/auth/roles\` when you need to check the signed-in user; the middleware has already redirected unauthed users.
- Owner-scoped writes: when inserting a row, ALWAYS set \`owner_id\` to the current user's id. The database has an RLS policy that refuses inserts without this; you must not lie about it.
- Return \`Response.json(...)\` or \`NextResponse.json(...)\` with explicit status codes (200 / 201 / 400 / 403 / 404 / 500).
- TypeScript strict mode is on. Type your handler signature: \`export async function GET(request: Request): Promise<Response>\` (and POST / PATCH / DELETE for the other methods).
- Validate every external input. For POST + PATCH, parse the JSON body and reject anything that isn't a plain object.

ABSOLUTE PROHIBITIONS:
- DO NOT import or reference SUPABASE_SERVICE_ROLE_KEY.
- DO NOT reimplement auth (no JWT decoding, no manual cookie reads, no alternative sign-in flow). The session middleware handles all of that.
- DO NOT bypass RLS by calling the service-role client. There is no service-role client in this project.
- DO NOT add new dependencies; stay within the pinned ones in package.json.

You will receive: the confirmed SoftwareSpec (for context), the target entity name + its column list, the slot kind (which method to generate), and the FULL exported surface of the scaffold. Generate ONLY the file requested.`;

export interface RouteUserMessageArgs {
  spec: SoftwareSpec;
  entityName: string;
  tableName: string;
  fields: ReadonlyArray<{ name: string; type: string }>;
  slotKind: 'list_route' | 'create_route' | 'update_route' | 'delete_route';
  filePath: string;
}

export function buildRouteUserMessage(args: RouteUserMessageArgs): string {
  const method = SLOT_METHOD[args.slotKind];
  const purpose = SLOT_PURPOSE[args.slotKind](args.entityName, args.tableName);
  return [
    'SOFTWARE SPEC (for context — DO NOT modify):',
    JSON.stringify(args.spec, null, 2),
    '',
    'TARGET ENTITY:',
    '  name:   ' + args.entityName,
    '  table:  ' + args.tableName,
    '  fields: ' +
      JSON.stringify(args.fields.map((f) => f.name + ':' + f.type)),
    '',
    'SCAFFOLD INTERFACE (the only modules you may import):',
    SCAFFOLD_INTERFACE,
    '',
    'GENERATE THIS FILE NOW:',
    '  Path:    ' + args.filePath,
    '  Method:  ' + method,
    '  Purpose: ' + purpose,
    '',
    'Output ONLY the file contents. Begin immediately with the first character of the file.',
  ].join('\n');
}

const SLOT_METHOD: Record<RouteUserMessageArgs['slotKind'], string> = {
  list_route: 'GET',
  create_route: 'POST',
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

// ---------------------------------------------------------------------------
// PAGE prompts — generate one server-component page body at a time.
// ---------------------------------------------------------------------------

export const PAGE_SYSTEM_PROMPT =
  `You are the Aurexis Forge SOFTWARE page generator.

You generate the BODY of ONE page in a Next.js (App Router) + Supabase project. The project's auth, session middleware, and Supabase client wiring are already scaffolded — use them, never reimplement.

OUTPUT RULES — non-negotiable:
- Output ONLY the file contents. No prose. No markdown code fences.
- Begin with the very first character of the file (e.g. \`import\`).
- Do not include the file path; do not include a preamble.

CODE RULES — non-negotiable:
- Server component by default (NO \`'use client'\` directive). Server components let you query the database directly via createServerClient() and get RLS-enforced results without an API round-trip.
- Default-export an async React component named after the page id.
- Use ONLY \`createServerClient\` from \`@/lib/supabase/server\`. Never import the browser client into a server component.
- Use \`userHasAnyRole\` from \`@/lib/auth/roles\` when the page is role-gated.
- TypeScript strict mode is on. Type props minimally (most pages take no props).
- Keep styling inline-or-minimal. The template's styling system isn't decided here; favour semantic HTML.

ABSOLUTE PROHIBITIONS:
- DO NOT import or reference SUPABASE_SERVICE_ROLE_KEY.
- DO NOT add a \`'use client'\` directive — every page in this codegen pass is a server component.
- DO NOT import lib/supabase/browser into a server file.
- DO NOT add new dependencies.

You will receive: the confirmed SoftwareSpec, the target page (id + purpose + flows it walks through), the entities the page is likely to touch, the scaffold interface, and the file path. Generate ONLY the file requested.`;

export interface PageUserMessageArgs {
  spec: SoftwareSpec;
  pageId: string;
  pageName: string;
  pagePurpose: string;
  // Entities mentioned in flows that touch this page — surfaced so
  // the LLM picks the right tables. Empty array = the LLM falls back
  // to ALL entities (rare; the planner usually picks at least one).
  relatedEntities: ReadonlyArray<string>;
  filePath: string;
}

export function buildPageUserMessage(args: PageUserMessageArgs): string {
  return [
    'SOFTWARE SPEC (for context):',
    JSON.stringify(args.spec, null, 2),
    '',
    'TARGET PAGE:',
    '  id:               ' + args.pageId,
    '  name:             ' + args.pageName,
    '  purpose:          ' + args.pagePurpose,
    '  related entities: ' + JSON.stringify(args.relatedEntities),
    '',
    'SCAFFOLD INTERFACE (the only modules you may import):',
    SCAFFOLD_INTERFACE,
    '',
    'GENERATE THIS FILE NOW:',
    '  Path:    ' + args.filePath,
    '  Server component: YES (no use-client)',
    '',
    'Output ONLY the file contents. Begin immediately with the first character of the file.',
  ].join('\n');
}

export function buildRepairUserMessage(error: string): string {
  return (
    'esbuild rejected your previous output:\n\n' +
    error +
    '\n\nReturn ONLY the corrected file content. No prose. No markdown code fences. Keep the file purpose and imports intact; fix the offending lines.'
  );
}
