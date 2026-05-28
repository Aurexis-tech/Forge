// Hermetic unit test — software per-slot prompt assembly.
//
// Tests the PROMPT BUILDERS for the two LLM-driven software slot
// families (ROUTE + PAGE). Auth + schema slots never reach an LLM,
// so they have no prompt builder to test.
//
// Given a sample (spec, entity/page, scaffold interface), each
// builder must produce a prompt that contains:
//
//   - The engine's BASE QUALITY_BAR (system prompt)
//   - The SOFTWARE ADDENDUM bullets for that family (system prompt)
//   - The slot CONTRACT (route: entity fields + types + method
//     semantics / page: purpose + flows + related entities)
//   - The SCAFFOLD INTERFACE verbatim
//   - The LAYER (api / ui)
//   - The SIBLING CONTRACT (route: peer methods; page: candidate
//     route paths)
//   - The family WORKED EXEMPLAR
//   - A FINAL INSTRUCTION naming the file path
//
// Stubbed: nothing — the builders are pure functions. No network,
// no LLM, no DB.

import { describe, expect, it } from 'vitest';
import {
  buildPageUserMessage,
  buildRepairUserMessage,
  buildRouteUserMessage,
  PAGE_SYSTEM_PROMPT,
  ROUTE_SYSTEM_PROMPT,
} from '@/lib/engine/software/codegen/prompts';
import {
  QUALITY_BAR,
  QUALITY_BAR_VERSION,
  qualityBarPromptBullets,
} from '@/lib/engine/codegen/quality';
import {
  SOFTWARE_QUALITY_ADDENDUM,
  SOFTWARE_ADDENDUM_VERSION,
  softwareAddendumPromptBullets,
} from '@/lib/engine/software/codegen/quality';
import { SoftwareSpecSchema, type SoftwareSpec } from '@/lib/engine/software/spec';

// ---------------------------------------------------------------------------
// Fixtures — minimal but schema-valid SoftwareSpec.
// ---------------------------------------------------------------------------
const sampleSpec: SoftwareSpec = SoftwareSpecSchema.parse({
  goal: 'A small expense tracker for individual users.',
  pages: [
    {
      id: 'list_expenses',
      name: 'My expenses',
      purpose: "List the signed-in user's expenses.",
    },
    {
      id: 'new_expense',
      name: 'Submit expense',
      purpose: 'Form to submit a new expense.',
    },
  ],
  entities: [
    {
      name: 'Expense',
      fields: [
        { name: 'amount', type: 'number' },
        { name: 'currency', type: 'string' },
        { name: 'description', type: 'text' },
      ],
    },
  ],
  flows: [
    {
      name: 'submit_expense',
      description:
        'User opens new_expense, fills the form, lands on expense_detail.',
      pages: ['new_expense'],
    },
    {
      name: 'view_history',
      description: "User opens list_expenses to see all of their expenses.",
      pages: ['list_expenses'],
    },
  ],
  auth: { requires_auth: true, roles: [], per_user_isolation: true },
  integrations: [],
});

// ===========================================================================
// SYSTEM PROMPTS — both families embed BASE BAR + SOFTWARE ADDENDUM
// ===========================================================================
describe('software ROUTE system prompt', () => {
  it('embeds every base QUALITY_BAR criterion', () => {
    for (const c of QUALITY_BAR) {
      expect(ROUTE_SYSTEM_PROMPT).toContain(c.label);
      expect(ROUTE_SYSTEM_PROMPT).toContain(c.imperative);
    }
  });

  it('records the BASE QUALITY BAR version', () => {
    expect(ROUTE_SYSTEM_PROMPT).toContain(
      'BASE QUALITY BAR (engine v' + QUALITY_BAR_VERSION + ')',
    );
  });

  it('reproduces qualityBarPromptBullets() verbatim', () => {
    expect(ROUTE_SYSTEM_PROMPT).toContain(qualityBarPromptBullets());
  });

  it('embeds the SOFTWARE ADDENDUM for the route family', () => {
    expect(ROUTE_SYSTEM_PROMPT).toContain(
      'SOFTWARE ADDENDUM (v' + SOFTWARE_ADDENDUM_VERSION + ')',
    );
    expect(ROUTE_SYSTEM_PROMPT).toContain(softwareAddendumPromptBullets('route'));
  });

  it('addendum bullets cover server-client-only AND owner-pinned writes', () => {
    // These are the two route-family items in the addendum; the
    // page-only "server components by default" rule should not
    // appear here.
    const routeOnlyIds = SOFTWARE_QUALITY_ADDENDUM.filter((c) =>
      c.appliesTo.includes('route'),
    ).map((c) => c.id);
    expect(routeOnlyIds).toContain('data_access_server_client_only');
    expect(routeOnlyIds).toContain('writes_pin_owner_id');
    expect(ROUTE_SYSTEM_PROMPT).toMatch(/createServerClient/);
    expect(ROUTE_SYSTEM_PROMPT).toMatch(/owner_id/);
  });

  it('forbids service-role + JWT decoding + cookie reads explicitly', () => {
    expect(ROUTE_SYSTEM_PROMPT).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(ROUTE_SYSTEM_PROMPT).toMatch(/NEVER decode JWTs/i);
    expect(ROUTE_SYSTEM_PROMPT).toMatch(/middleware has authed/i);
  });

  it('pins the export shape (HTTP method names + Response.json)', () => {
    expect(ROUTE_SYSTEM_PROMPT).toMatch(/GET \/ POST \/ PATCH \/ DELETE/);
    expect(ROUTE_SYSTEM_PROMPT).toMatch(/Response\.json/);
  });
});

describe('software PAGE system prompt', () => {
  it('embeds every base QUALITY_BAR criterion', () => {
    for (const c of QUALITY_BAR) {
      expect(PAGE_SYSTEM_PROMPT).toContain(c.label);
    }
  });

  it('embeds the SOFTWARE ADDENDUM for the page family', () => {
    expect(PAGE_SYSTEM_PROMPT).toContain(softwareAddendumPromptBullets('page'));
  });

  it("addendum surfaces 'server components by default' for pages", () => {
    const pageOnlyIds = SOFTWARE_QUALITY_ADDENDUM.filter((c) =>
      c.appliesTo.includes('page'),
    ).map((c) => c.id);
    expect(pageOnlyIds).toContain('pages_server_components_by_default');
    expect(PAGE_SYSTEM_PROMPT).toMatch(/server component/i);
    expect(PAGE_SYSTEM_PROMPT).toMatch(/'use client'/);
  });

  it('prohibits the browser supabase client + service-role + use-client', () => {
    expect(PAGE_SYSTEM_PROMPT).toMatch(/@\/lib\/supabase\/browser/);
    expect(PAGE_SYSTEM_PROMPT).toMatch(/'use client'/);
    expect(PAGE_SYSTEM_PROMPT).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*=/);
  });
});

// ===========================================================================
// ROUTE USER MESSAGE
// ===========================================================================
describe('software ROUTE user message — list_route', () => {
  const message = buildRouteUserMessage({
    spec: sampleSpec,
    entityName: 'Expense',
    tableName: 'expense',
    fields: [
      { name: 'amount', type: 'number' },
      { name: 'currency', type: 'string' },
    ],
    slotKind: 'list_route',
    filePath: 'app/api/expense/_list.ts',
  });

  it('has every required section in order', () => {
    const sections = [
      'PURPOSE',
      'SLOT CONTRACT',
      'SCAFFOLD INTERFACE',
      'LAYER',
      'SIBLING CONTRACT',
      'WORKED EXEMPLAR',
      'GENERATE THIS FILE NOW',
    ];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = message.indexOf(s);
      expect(idx, "section '" + s + "' present").toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('surfaces the slot contract: entity, table, typed fields, method semantics', () => {
    expect(message).toContain('entity: Expense');
    expect(message).toContain('table:  expense');
    expect(message).toContain('amount :: number');
    expect(message).toContain('currency :: string');
    expect(message).toMatch(/method semantics:/);
    // list_route semantic detail mentions ordering + Response.json
    expect(message).toContain('SELECT from `expense`');
    expect(message).toMatch(/Response\.json/);
  });

  it("layer section anchors this file as 'api' / server-only", () => {
    expect(message).toMatch(/LAYER[\s\S]*?'api'/);
    expect(message).toMatch(/SERVER-ONLY route handlers/);
  });

  it('sibling contract lists the peer methods on the same table', () => {
    expect(message).toContain('POST /api/expense');
    expect(message).toContain('PATCH /api/expense/[id]');
    expect(message).toContain('DELETE /api/expense/[id]');
  });

  it('embeds the route WORKED EXEMPLAR with the owner-pinned write pattern', () => {
    expect(message).toMatch(/WORKED EXEMPLAR.*DO NOT COPY VERBATIM/);
    // The exemplar visibly demonstrates owner-pinning and server client
    expect(message).toContain('createServerClient');
    expect(message).toContain('currentUserId');
    expect(message).toContain('owner_id: userId');
    // No TODO inside the exemplar
    expect(message).not.toMatch(/\bTODO\b/);
  });

  it('embeds SCAFFOLD INTERFACE verbatim with no service-role reference', () => {
    expect(message).toContain('createServerClient');
    expect(message).toMatch(/SUPABASE_SERVICE_ROLE_KEY is intentionally NOT exposed/);
  });

  it('final instruction names the file path + method', () => {
    expect(message).toContain('Path:    app/api/expense/_list.ts');
    expect(message).toContain('Method:  GET');
  });
});

describe('software ROUTE user message — create_route shows owner-pinned semantic detail', () => {
  const message = buildRouteUserMessage({
    spec: sampleSpec,
    entityName: 'Expense',
    tableName: 'expense',
    fields: [{ name: 'amount', type: 'number' }],
    slotKind: 'create_route',
    filePath: 'app/api/expense/_create.ts',
  });

  it("create_route detail instructs to pin owner_id server-side", () => {
    expect(message).toMatch(/INSERT into `expense`/);
    expect(message).toMatch(/owner_id: userId/);
    expect(message).toMatch(/NEVER read owner_id from the request body/i);
    expect(message).toMatch(/status 201/);
  });
});

describe('software ROUTE user message — update_route warns against owner_id passthrough', () => {
  const message = buildRouteUserMessage({
    spec: sampleSpec,
    entityName: 'Expense',
    tableName: 'expense',
    fields: [{ name: 'amount', type: 'number' }],
    slotKind: 'update_route',
    filePath: 'app/api/expense/[id]/_update.ts',
  });

  it('update_route detail flags privilege escalation if owner_id is supplied', () => {
    expect(message).toMatch(/Do NOT pass owner_id/);
    expect(message).toMatch(/privilege-escalation/);
    expect(message).toMatch(/404 when/);
  });
});

// ===========================================================================
// PAGE USER MESSAGE
// ===========================================================================
describe('software PAGE user message', () => {
  const message = buildPageUserMessage({
    spec: sampleSpec,
    pageId: 'list_expenses',
    pageName: 'My expenses',
    pagePurpose: "List the signed-in user's expenses.",
    relatedEntities: ['Expense'],
    filePath: 'app/(app)/list-expenses/page.tsx',
  });

  it('has every required section in order', () => {
    const sections = [
      'PURPOSE',
      'SLOT CONTRACT',
      'SCAFFOLD INTERFACE',
      'LAYER',
      'SIBLING CONTRACT',
      'WORKED EXEMPLAR',
      'GENERATE THIS FILE NOW',
    ];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = message.indexOf(s);
      expect(idx, "section '" + s + "' present").toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('surfaces page id, name, purpose, related entities, and flows', () => {
    expect(message).toContain('Page id: list_expenses');
    expect(message).toContain('Page name: My expenses');
    expect(message).toContain("List the signed-in user's expenses.");
    expect(message).toContain('related entities (the page likely reads from these tables): Expense');
    expect(message).toMatch(/flows touching this page:/);
    expect(message).toContain('view_history');
  });

  it('anchors the page in the ui layer with server-component instruction', () => {
    expect(message).toMatch(/LAYER[\s\S]*?'ui'/);
    expect(message).toMatch(/SERVER COMPONENTS by default/);
    expect(message).toMatch(/'use client'/);
  });

  it('sibling contract names the candidate route paths derived from related entities', () => {
    expect(message).toMatch(/\/api\/expense\s+\(GET = list/);
  });

  it("embeds the page WORKED EXEMPLAR as a server component (no 'use client' directive)", () => {
    expect(message).toMatch(/WORKED EXEMPLAR.*DO NOT COPY VERBATIM/);
    expect(message).toContain('export default async function WidgetListPage');
    expect(message).toContain('createServerClient');
    // Extract just the exemplar code block — between the WORKED
    // EXEMPLAR heading and the closing notice — so assertions about
    // "what's inside the exemplar" don't trip on legitimate
    // mentions elsewhere (the SCAFFOLD_INTERFACE mentions
    // lib/supabase/browser in its "never import" comment; the
    // LAYER section discusses 'use client' as forbidden).
    const exemplarMatch = message.match(/WORKED EXEMPLAR[\s\S]*?```([\s\S]*?)```/);
    expect(exemplarMatch).not.toBeNull();
    const exemplarCode = exemplarMatch![1];
    // No 'use client' DIRECTIVE inside the exemplar code block.
    expect(exemplarCode).not.toMatch(/^\s*['"]use client['"]\s*;?\s*$/m);
    // No browser client imported inside the exemplar code.
    expect(exemplarCode).not.toMatch(/lib\/supabase\/browser/);
    // No TODO anywhere in the exemplar.
    expect(exemplarCode).not.toMatch(/\bTODO\b/);
  });

  it("PURPOSE block reflects the project's goal too", () => {
    expect(message).toContain(
      'Project goal: A small expense tracker for individual users.',
    );
  });

  it('final instruction marks the page as a server component', () => {
    expect(message).toContain('Server component: YES (no use-client)');
  });
});

describe('software PAGE user message — no related entities falls back gracefully', () => {
  const message = buildPageUserMessage({
    spec: sampleSpec,
    pageId: 'list_expenses',
    pageName: 'My expenses',
    pagePurpose: 'a generic page',
    relatedEntities: [],
    filePath: 'app/(app)/list-expenses/page.tsx',
  });

  it("falls back to a 'no related entity inferred' note in the slot contract", () => {
    expect(message).toMatch(/no related entity inferred/);
  });

  it('sibling contract advises direct query when no entity inferred', () => {
    expect(message).toMatch(/query the spec entity most relevant.*directly via createServerClient/);
  });
});

// ===========================================================================
// REPAIR MESSAGE — re-asserts BOTH bars
// ===========================================================================
describe('software repair message', () => {
  it('echoes the esbuild error and re-asserts both bars', () => {
    const msg = buildRepairUserMessage('Unexpected token at line 4');
    expect(msg).toContain('esbuild rejected your previous output:');
    expect(msg).toContain('Unexpected token at line 4');
    expect(msg).toMatch(/BASE QUALITY BAR/);
    expect(msg).toMatch(/SOFTWARE ADDENDUM/);
  });
});
