// Prompts for the INFRASTRUCTURE spec extractor.
//
// REFACTOR (spec-fidelity leg) — mirrors the agent / system / software
// refactors: SYSTEM prompt embeds the SPEC_QUALITY_BAR + INFRA addendum;
// user message is structured (intent / clarifications / catalog slice /
// schema / exemplar); repair message re-asserts the bar.

import {
  specQualityBarPromptBullets,
  specQualityBarVersionLabel,
} from '../spec/quality';
import { RESOURCE_TYPES } from './spec';

// ===========================================================================
// SYSTEM PROMPT — built once at module load.
// ===========================================================================
export const INFRA_SPEC_SYSTEM_PROMPT: string = (() => {
  const role =
    "You are the Aurexis Forge INFRASTRUCTURE spec extractor. Your job is to read a user's natural-language intent about DATA OR RUNTIME PLUMBING (databases, object stores, queues, workers, scheduled jobs, http services) and produce a precise, actionable InfraSpec — a set of catalog-grounded resources connected by a topology. Treat every field as a contract; downstream layers (planner, IaC composer, provisioner) rely on it without re-asking the user. An INFRASTRUCTURE request is when the user wants plumbing, not a single agent, multi-agent system, or web app. The caller routes by classifier.";

  const bar =
    'SPEC QUALITY BAR (' +
    specQualityBarVersionLabel('infrastructure') +
    ') — your output MUST satisfy every one of these:\n' +
    specQualityBarPromptBullets('infrastructure');

  const outputRules =
    'OUTPUT RULES — non-negotiable:\n' +
    '- Respond with a SINGLE JSON object — no prose before or after, no markdown code fences.\n' +
    '- The object MUST conform to the InfraSpec ExtractionResult schema shown below.\n' +
    '- Required fields MUST contain real content. Never emit placeholders ("TBD", "various") — surface gaps via `open_questions`.';

  const schema =
    'INFRA SPEC EXTRACTION SCHEMA (target shape):\n' +
    '{\n' +
    '  "spec": {\n' +
    '    "goal": string,\n' +
    '    "resources": [\n' +
    '      {\n' +
    '        "id":     string,                            // lower_snake_case, unique within this spec\n' +
    '        "type":   string,                            // ONE OF the RESOURCE_TYPES catalog below\n' +
    '        "config": { <key>: <string|number|boolean|null|string[]>, ... },  // shallow, <=20 keys\n' +
    '        "sizing": { "note"?: string, "instances"?: number, "storage_gb"?: number }  // OPTIONAL\n' +
    '      },\n' +
    '      ...\n' +
    '    ],\n' +
    '    "topology": [ { "from": <resource.id>, "to": <resource.id> }, ... ],\n' +
    '    "region":    string,                             // OPTIONAL — only include if the user named one\n' +
    '    "lifecycle": "ephemeral" | "persistent"\n' +
    '  },\n' +
    '  "open_questions": [string, ...]\n' +
    '}';

  return [role, '', bar, '', outputRules, '', schema].join('\n');
})();

// ===========================================================================
// CATALOG SLICE — RESOURCE_TYPES + per-type config hints.
// ===========================================================================
function resourceTypesSlice(): string {
  return [
    'RESOURCE TYPE CATALOG (the closed set of `resources[].type` values):',
    '  - postgres_db   — relational database the user wants to store records in.',
    '  - object_store  — file/blob storage (S3-like). Use for "upload to a bucket", "store files", "backups".',
    '  - queue         — message queue between producers and consumers.',
    '  - worker        — long-running background process that consumes a queue or processes records.',
    '  - cron          — SCHEDULED job that fires on an interval ("every hour", "nightly").',
    '  - http_service  — HTTP endpoint / API that other tools call.',
    '  - cache         — in-memory cache (Redis-like). Use for "cache", "speed up reads", "session store".',
    '  - secret_store  — managed secret store. Use for "store API keys/credentials", "secrets manager".',
    '  - cdn           — content delivery / edge in front of an http_service or object store ("CDN", "serve assets fast globally").',
    '',
    'Available types (use ONLY these): ' + RESOURCE_TYPES.join(', '),
    '',
    'PER-TYPE config hints (capture what the user mentioned in `config`):',
    '  - cron:         { "schedule": "every hour" | "0 3 * * *" | ... }',
    '  - http_service: { "framework"?: "nextjs"|"fastapi"|..., "endpoints"?: ["/events", "/health"] }',
    '  - worker:       { "runtime"?: "node"|"python", "concurrency"?: 2 }',
    '  - queue:        { "ordering"?: "fifo"|"unordered" }',
    '  - postgres_db:  { "version"?: "16", "schema_hint"?: "events table with id, source, ts, payload" }',
    '  - object_store: { "bucket_hint"?: "raw-events" }',
    '  - cache:        { "node_type"?: "small", "engine_version"?: "7" }',
    '  - secret_store: { "rotation_days"?: 30 }',
    '  - cdn:          { "price_class"?: "100" }   // wire the origin via a topology edge cdn -> <http_service|object_store>',
  ].join('\n');
}

// ===========================================================================
// USER MESSAGE — structured context.
// ===========================================================================
export interface InfraExtractionUserMessageArgs {
  rawPrompt: string;
  answers?: ReadonlyArray<{ question: string; answer: string }>;
  refinements?: ReadonlyArray<string>;
}

export function buildInfraExtractionUserMessage(
  args: InfraExtractionUserMessageArgs,
): string {
  return [
    sectionIntent(args.rawPrompt),
    args.answers && args.answers.length > 0
      ? sectionClarifications(args.answers)
      : null,
    args.refinements && args.refinements.length > 0
      ? sectionRefinements(args.refinements)
      : null,
    resourceTypesSlice(),
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
    'Intent:   "An events pipeline in us-east-1: a queue, a worker that consumes it and writes to Postgres, and a nightly backup of the database to S3."',
    '',
    'Good spec:',
    '{',
    '  "spec": {',
    '    "goal": "Ingest events through a queue, persist them to Postgres, and back up nightly to object storage.",',
    '    "resources": [',
    '      { "id": "events_queue",   "type": "queue",        "config": { "ordering": "fifo" } },',
    '      { "id": "events_worker",  "type": "worker",       "config": { "runtime": "node", "concurrency": 2 } },',
    '      { "id": "events_db",      "type": "postgres_db",  "config": { "version": "16", "schema_hint": "events(id, source, ts, payload)" }, "sizing": { "storage_gb": 50 } },',
    '      { "id": "nightly_backup", "type": "cron",         "config": { "schedule": "0 3 * * *" } },',
    '      { "id": "backup_bucket",  "type": "object_store", "config": { "bucket_hint": "events-backup" } }',
    '    ],',
    '    "topology": [',
    '      { "from": "events_worker",  "to": "events_queue" },',
    '      { "from": "events_worker",  "to": "events_db"    },',
    '      { "from": "nightly_backup", "to": "events_db"    },',
    '      { "from": "nightly_backup", "to": "backup_bucket" }',
    '    ],',
    '    "region": "us-east-1",',
    '    "lifecycle": "persistent"',
    '  },',
    '  "open_questions": []',
    '}',
    '',
    'Notice: every resource type is from the catalog, topology names real ids, lifecycle = persistent (data survives), region captured exactly as the user said it, sizing on the database where the user implied scale.',
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
export function buildInfraRepairUserMessage(error: string): string {
  return [
    'Your previous response could not be parsed: ' + error,
    '',
    'Return ONLY the corrected JSON object — no prose, no markdown code fences. Keep the spec content; fix the structure / fields that violated the schema. Continue to satisfy the SPEC QUALITY BAR (base + infrastructure addendum) you were given.',
  ].join('\n');
}
