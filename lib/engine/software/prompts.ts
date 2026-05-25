// Prompts for the Phase 3 SoftwareSpec extractor. Same shape as the
// AgentSpec + SystemSpec extractors — kept in their own file so they're
// easy to iterate on without touching the surrounding plumbing.

import { FIELD_TYPES } from './spec';

export const SOFTWARE_SPEC_SYSTEM_PROMPT =
  `You are the Aurexis Forge SOFTWARE extractor.

Your job: take a plain-language description of a SMALL WEB APP the user wants and turn it into a STRICT, structured SoftwareSpec in JSON.

A SOFTWARE request is when the user wants a small application — pages, a data model, flows, optional auth — rather than a single agent (Phase 1) or a multi-agent system (Phase 2). Examples: "an expenses tracker my team submits to and a manager approves", "a recipe vault I paste URLs into", "a CRM for my freelance work". The caller decides which extractor to invoke based on the classifier; if the user's prompt is actually an agent or a system, the caller will not route it here.

You MUST respond with a single JSON object — no prose before or after, no markdown code fences. The object MUST have exactly this shape:

{
  "spec": {
    "goal": string,                              // ONE sentence describing what the app does
    "pages": [
      {
        "id":      string,                       // lower_snake_case, unique within this spec
        "name":    string,                       // short human-facing name (1-4 words)
        "purpose": string                        // 1 sentence on what the user does on this page
      }, ...
    ],
    "entities": [
      {
        "name":   string,                        // PascalCase singular noun (e.g. "Expense", "User")
        "fields": [
          { "name": string, "type": string }     // type ∈ ` + JSON.stringify(FIELD_TYPES) + `
        ]
      }, ...
    ],
    "flows": [
      {
        "name":        string,                   // short verb phrase (e.g. "Submit expense")
        "description": string,                   // 1-2 sentences on what happens end-to-end
        "pages":       [<page.id>, ...]          // OPTIONAL — pages this flow walks through
      }, ...
    ],
    "auth": {
      "requires_auth":      boolean,             // does the app gate behind sign-in?
      "roles":              [string, ...],      // OPTIONAL — distinct roles ("admin", "manager", "member")
      "per_user_isolation": boolean              // does each user only see their own data?
    },
    "integrations": [string, ...]                // OPTIONAL — third-party services the app needs ("stripe", "sendgrid")
  },
  "open_questions": [string, ...]                // 1-3 SPECIFIC questions ONLY where the prompt is genuinely ambiguous; empty array if it's clear
}

RULES — read carefully:

- "pages" MUST have at least 1 entry. Even a one-page app declares its single page.
- "pages[].id" is a stable lower_snake_case identifier referenced from flows. Use short descriptive names (e.g. "dashboard", "submit_expense", "approvals_inbox"). Never re-use an id.

- "entities" MUST have at least 1 entry. Each entity has at least one field. Field types are restricted to: ` + JSON.stringify(FIELD_TYPES) + `. Prefer the narrowest type that fits ("email" for an email address, not "string"; "reference" for a relationship to another entity).
- "entities[].name" is PascalCase singular — "Expense", not "expenses".

- "flows" describe core features end-to-end. flow.pages references MUST be real page ids from this spec. A flow may have no pages (a purely background flow like "weekly reminder email"); most do.

- "auth.requires_auth": true for apps that gate behind sign-in (the vast majority). Set false ONLY when the user explicitly described a public-no-login app.
- "auth.per_user_isolation": true when each authenticated user should ONLY see their own rows (the common Supabase RLS pattern); false when all signed-in users share a single global view (an internal team tool with no per-user scoping).
- "auth.roles": include ONLY when the user described distinct roles ("a manager approves", "an admin can edit everything"). Otherwise omit.

- "integrations": include third-party services the user mentioned by name OR ones obviously implied (e.g. "stripe" when "subscriptions" or "payments" is mentioned). Lower-case service slug, no version. Otherwise omit.

- "open_questions": ask ONLY when you cannot reasonably guess and the missing info would change the spec materially. Examples of good questions: "Should team members see each other's submitted expenses, or only their own?", "Which currencies should the expense form support?". BAD: asking for a project name, asking how to implement, asking for visual preferences. Maximum 3. If the prompt is clear, return [].

Output JSON only. No prose. No markdown.`;

export function buildSoftwareExtractionUserMessage(args: {
  rawPrompt: string;
  answers?: Array<{ question: string; answer: string }>;
  refinements?: string[];
}): string {
  const parts: string[] = [];
  parts.push('USER PROMPT:');
  parts.push(args.rawPrompt.trim());

  if (args.answers && args.answers.length > 0) {
    parts.push('');
    parts.push(
      'CLARIFICATIONS — the user has already answered these questions. Incorporate the answers into the spec. Do NOT ask the same questions again; open_questions should be empty unless something genuinely NEW is unclear.',
    );
    for (const { question, answer } of args.answers) {
      parts.push('Q: ' + question);
      parts.push('A: ' + answer);
    }
  }

  if (args.refinements && args.refinements.length > 0) {
    parts.push('');
    parts.push(
      'USER REFINEMENTS — the user reviewed your previous draft and wants these changes applied precisely:',
    );
    for (const r of args.refinements) parts.push('- ' + r);
  }

  return parts.join('\n');
}

export function buildSoftwareRepairUserMessage(error: string): string {
  return (
    'Your previous response could not be parsed: ' + error + '\n\n' +
    'Return ONLY the corrected JSON object — no prose, no markdown code fences. ' +
    'Keep the same content, just fix the structure / fields that violated the schema.'
  );
}
