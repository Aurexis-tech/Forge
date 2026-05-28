// Prompts for the SOFTWARE spec extractor.
//
// REFACTOR (spec-fidelity leg) — mirrors the agent + system refactors:
// SYSTEM prompt embeds the SPEC_QUALITY_BAR + SOFTWARE addendum;
// user message is structured (intent / clarifications / catalog
// slice / schema / exemplar); repair message re-asserts the bar.

import {
  specQualityBarPromptBullets,
  specQualityBarVersionLabel,
} from '../spec/quality';
import { FIELD_TYPES } from './spec';

// ===========================================================================
// SYSTEM PROMPT — built once at module load.
// ===========================================================================
export const SOFTWARE_SPEC_SYSTEM_PROMPT: string = (() => {
  const role =
    'You are the Aurexis Forge SOFTWARE spec extractor. Your job is to read a user\'s natural-language intent and produce a precise, actionable SoftwareSpec — pages, entities (with typed fields), flows, and an auth model — so downstream layers (planner, codegen, sandbox) can build a small full-stack app without re-asking the user. A SOFTWARE request is when the user wants a small application with pages + a data model, not a single agent or multi-agent system. The caller routes by classifier; if the prompt is actually an agent / system, the caller will not invoke this extractor.';

  const bar =
    'SPEC QUALITY BAR (' +
    specQualityBarVersionLabel('software') +
    ') — your output MUST satisfy every one of these:\n' +
    specQualityBarPromptBullets('software');

  const outputRules =
    'OUTPUT RULES — non-negotiable:\n' +
    '- Respond with a SINGLE JSON object — no prose before or after, no markdown code fences.\n' +
    '- The object MUST conform to the SoftwareSpec ExtractionResult schema shown below.\n' +
    '- Required fields MUST contain real content. Never emit placeholders ("TBD", "various fields") — surface gaps via `open_questions`.';

  const schema =
    'SOFTWARE SPEC EXTRACTION SCHEMA (target shape):\n' +
    '{\n' +
    '  "spec": {\n' +
    '    "goal": string,\n' +
    '    "pages": [\n' +
    '      { "id": string, "name": string, "purpose": string },  // id lower_snake_case, unique\n' +
    '      ...\n' +
    '    ],\n' +
    '    "entities": [\n' +
    '      {\n' +
    '        "name":   string,                                    // PascalCase singular (e.g. "Expense")\n' +
    '        "fields": [ { "name": string, "type": string }, ... ]  // type from FIELD_TYPES catalog\n' +
    '      },\n' +
    '      ...\n' +
    '    ],\n' +
    '    "flows": [\n' +
    '      {\n' +
    '        "name": string,                                      // short snake_case name (e.g. "submit_expense")\n' +
    '        "description": string,                               // 1 sentence\n' +
    '        "pages": [string, ...]                               // OPTIONAL — page ids the flow walks through\n' +
    '      },\n' +
    '      ...\n' +
    '    ],\n' +
    '    "auth": {\n' +
    '      "requires_auth": boolean,\n' +
    '      "roles": [string, ...],                                // OPTIONAL — free-form role labels\n' +
    '      "per_user_isolation": boolean\n' +
    '    },\n' +
    '    "integrations": [string, ...]                            // OPTIONAL — e.g. "stripe", "sendgrid"\n' +
    '  },\n' +
    '  "open_questions": [string, ...]\n' +
    '}';

  return [role, '', bar, '', outputRules, '', schema].join('\n');
})();

// ===========================================================================
// CATALOG SLICE — FIELD_TYPES rendered for the prompt.
// ===========================================================================
function fieldTypesSlice(): string {
  return [
    'FIELD TYPE CATALOG (the closed set of `entities[].fields[].type` values):',
    '  ' + FIELD_TYPES.join(', '),
    '',
    "Pick the closest match for each field. Do not invent types. For 'metadata' / unstructured blobs use 'text'. For an entity reference, use 'reference' and name the target entity in the field name (e.g. 'submitted_by' referencing User).",
  ].join('\n');
}

// ===========================================================================
// USER MESSAGE — structured context.
// ===========================================================================
export interface SoftwareExtractionUserMessageArgs {
  rawPrompt: string;
  answers?: ReadonlyArray<{ question: string; answer: string }>;
  refinements?: ReadonlyArray<string>;
}

export function buildSoftwareExtractionUserMessage(
  args: SoftwareExtractionUserMessageArgs,
): string {
  return [
    sectionIntent(args.rawPrompt),
    args.answers && args.answers.length > 0
      ? sectionClarifications(args.answers)
      : null,
    args.refinements && args.refinements.length > 0
      ? sectionRefinements(args.refinements)
      : null,
    fieldTypesSlice(),
    sectionExemplar(),
    sectionFinalInstruction(),
  ]
    .filter((s): s is string => s !== null)
    .join('\n\n');
}

function sectionIntent(rawPrompt: string): string {
  return ['USER INTENT (verbatim):', rawPrompt.trim()].join('\n');
}

function sectionClarifications(
  answers: ReadonlyArray<{ question: string; answer: string }>,
): string {
  const lines: string[] = [
    'CLARIFICATIONS — the user has already answered these questions. Incorporate the answers; do not re-ask.',
  ];
  for (const { question, answer } of answers) {
    lines.push('Q: ' + question);
    lines.push('A: ' + answer);
  }
  return lines.join('\n');
}

function sectionRefinements(refinements: ReadonlyArray<string>): string {
  const lines: string[] = [
    'USER REFINEMENTS — apply these changes precisely:',
  ];
  for (const r of refinements) lines.push('- ' + r);
  return lines.join('\n');
}

function sectionExemplar(): string {
  return [
    'WORKED EXEMPLAR (illustrative — DO NOT COPY VERBATIM)',
    '',
    'Intent:   "A reading queue: I paste article URLs, the app tags each one, and I can mark them as read."',
    '',
    'Good spec:',
    '{',
    '  "spec": {',
    '    "goal": "A personal reading queue: paste article URLs, see tagged unread items, mark them as read.",',
    '    "pages": [',
    '      { "id": "queue",         "name": "Queue",       "purpose": "List unread articles with tags + a checkbox to mark each as read." },',
    '      { "id": "add_article",   "name": "Add article", "purpose": "Paste a URL; the app saves it tagged for later." },',
    '      { "id": "archive",       "name": "Archive",     "purpose": "Browse articles already marked as read." }',
    '    ],',
    '    "entities": [',
    '      {',
    '        "name": "Article",',
    '        "fields": [',
    '          { "name": "url",        "type": "url" },',
    '          { "name": "title",      "type": "string" },',
    '          { "name": "tags",       "type": "text" },',
    '          { "name": "added_at",   "type": "datetime" },',
    '          { "name": "read",       "type": "boolean" },',
    '          { "name": "read_at",    "type": "datetime" }',
    '        ]',
    '      }',
    '    ],',
    '    "flows": [',
    '      { "name": "add_article",   "description": "User pastes a URL and lands on the queue with the new item.",       "pages": ["add_article", "queue"] },',
    '      { "name": "mark_as_read",  "description": "User toggles the read checkbox; the item moves from queue to archive.", "pages": ["queue", "archive"] }',
    '    ],',
    '    "auth": { "requires_auth": true, "per_user_isolation": true },',
    '    "integrations": []',
    '  },',
    '  "open_questions": []',
    '}',
    '',
    'Notice: three named pages (not one generic "main"), Article entity with concrete field types from the catalog (url / boolean / datetime), named flows linking pages, auth explicit (requires_auth + per_user_isolation), no integrations invented.',
  ].join('\n');
}

function sectionFinalInstruction(): string {
  return [
    'PRODUCE THE EXTRACTION NOW',
    'Return ONLY the JSON object described above. No prose. No fences.',
  ].join('\n');
}

// ===========================================================================
// REPAIR MESSAGE
// ===========================================================================
export function buildSoftwareRepairUserMessage(error: string): string {
  return [
    'Your previous response could not be parsed: ' + error,
    '',
    'Return ONLY the corrected JSON object — no prose, no markdown code fences. Keep the spec content; fix the structure / fields that violated the schema. Continue to satisfy the SPEC QUALITY BAR (base + software addendum) you were given.',
  ].join('\n');
}
