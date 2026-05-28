// The SOFTWARE QUALITY ADDENDUM — extends the engine-owned base
// QUALITY_BAR (lib/engine/codegen/quality.ts) with the data-layer
// criteria that make a generated route or page correct AND safe by
// COOPERATING with the RLS the template already enforces.
//
// THIS FILE IS THE SOURCE OF TRUTH for the software-specific bar.
//
// Read by two consumers:
//
//   1. The per-family software prompts (lib/engine/software/codegen/
//      prompts.ts) — embed every addendum criterion's `imperative`
//      verbatim in the route + page system prompts so the LLM is
//      INSTRUCTED against the exact additional bar the harness
//      MEASURES against.
//
//   2. The eval rubric drift-guard (evals/rubric.ts) — validates
//      that any addendum id the rubric or golden case references
//      still resolves to a real entry here. Fails loudly at module
//      load if an id has vanished.
//
// Dependency direction: ENGINE owns this. evals/ imports from here.
// NEVER the reverse.
//
// AUTH + SCHEMA SLOTS DO NOT REACH THE LLM. The slot dispatch
// (slots.ts) routes those to the deterministic scaffold + migration
// modules. This addendum applies ONLY to the LLM-driven route + page
// slots — the model never sees auth code to write, and these rules
// keep its routes/pages from inventing alternative auth or breaking
// the RLS the template established.

export const SOFTWARE_ADDENDUM_VERSION = '1.0.0';

export const SOFTWARE_ADDENDUM_IDS = [
  'data_access_server_client_only',
  'writes_pin_owner_id',
  'pages_server_components_by_default',
] as const;
export type SoftwareAddendumId = (typeof SOFTWARE_ADDENDUM_IDS)[number];

export interface SoftwareQualityCriterion {
  readonly id: SoftwareAddendumId;
  readonly label: string;
  /** Imperative sentence the prompt renders verbatim. */
  readonly imperative: string;
  /** Why it matters. Shown in the prompt and in eval reports. */
  readonly rationale: string;
  /**
   * Which slot families this criterion applies to. Used by the
   * per-family prompt builder to only surface relevant criteria
   * (e.g. the "server components by default" rule is page-only).
   */
  readonly appliesTo: ReadonlyArray<'route' | 'page'>;
}

export const SOFTWARE_QUALITY_ADDENDUM: readonly SoftwareQualityCriterion[] = [
  {
    id: 'data_access_server_client_only',
    label: 'Data access ONLY through the RLS-scoped server client',
    imperative:
      'Every database call MUST go through `createServerClient()` from `@/lib/supabase/server`. Never import the browser client into a server file. Never reference `SUPABASE_SERVICE_ROLE_KEY` or build an alternative client. Never decode JWTs or read auth cookies by hand — the template owns auth, and the session middleware has already rejected unauthed requests by the time your handler / page body runs.',
    rationale:
      "The RLS policies enforce per-user isolation at the database layer; they ONLY apply when the user-scoped server client is used. A browser client or a service-role client bypasses the proof and re-opens the cross-user data leak the template was built to prevent.",
    appliesTo: ['route', 'page'],
  },
  {
    id: 'writes_pin_owner_id',
    label: 'Every write pins owner_id to the current user',
    imperative:
      'On every INSERT / UPSERT, set `owner_id` to the value returned by `currentUserId()` from `@/lib/auth/roles`. NEVER read `owner_id` from the request body, the query string, or any client-supplied source. UPDATE / DELETE statements must rely on RLS for ownership enforcement (no manual `where owner_id = ?` mirror the client supplies).',
    rationale:
      "A client that supplies its own owner_id can write rows owned by another user — exactly the failure mode the per-user isolation test (P3-4) is designed to catch. Pinning to currentUserId() server-side closes the gap and matches the RLS policy's WITH CHECK clause.",
    appliesTo: ['route'],
  },
  {
    id: 'pages_server_components_by_default',
    label: 'Pages are server components by default',
    imperative:
      "Do NOT add a `'use client'` directive. Default-export an async React component that calls the database directly via `createServerClient()`. Only escalate to a client component when the page genuinely needs interactivity that cannot be served by a form-action + a server route. When you do escalate, you still MUST NOT import the browser supabase client — talk to the server through a route handler instead.",
    rationale:
      "Server components keep the supabase server client (and its RLS-enforced reads) on the server side of the wire. Marking a page 'use client' moves rendering and (more dangerously) data fetching to the browser, where the only available client is the unscoped public one.",
    appliesTo: ['page'],
  },
];

// ---------------------------------------------------------------------------
// Prompt rendering helpers.
// ---------------------------------------------------------------------------

/**
 * Render the addendum as a numbered list of imperative bullets for a
 * specific slot family. The route prompt and the page prompt call
 * this with their family discriminator; only criteria tagged for
 * that family appear in the rendered output. Single source of truth
 * — the prompts MUST NOT duplicate the imperative text inline.
 */
export function softwareAddendumPromptBullets(
  family: 'route' | 'page',
): string {
  const relevant = SOFTWARE_QUALITY_ADDENDUM.filter((c) =>
    c.appliesTo.includes(family),
  );
  return relevant
    .map(
      (c, i) =>
        '  ' +
        String(i + 1).padStart(2, ' ') +
        '. ' +
        c.label +
        ' — ' +
        c.imperative +
        ' (' +
        c.rationale +
        ')',
    )
    .join('\n');
}

/** Compact one-liner for audit detail / logs. */
export function softwareAddendumSummary(): string {
  return (
    'v' +
    SOFTWARE_ADDENDUM_VERSION +
    ': ' +
    SOFTWARE_QUALITY_ADDENDUM.map((c) => c.id).join(', ')
  );
}

/** Used by evals/rubric.ts to drift-guard referenced ids. */
export function knownSoftwareAddendumIds(): ReadonlySet<SoftwareAddendumId> {
  return new Set(SOFTWARE_QUALITY_ADDENDUM.map((c) => c.id));
}
