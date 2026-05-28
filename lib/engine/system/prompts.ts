// Prompts for the SYSTEM spec extractor.
//
// REFACTOR (spec-fidelity leg) — mirrors the agent prompt refactor:
// SYSTEM prompt embeds the SPEC_QUALITY_BAR + SYSTEM addendum;
// user message is structured (intent / clarifications / catalog
// slice / schema / exemplar); repair message re-asserts the bar.

import {
  specQualityBarPromptBullets,
  specQualityBarVersionLabel,
} from '../spec/quality';
import {
  COORDINATION_PATTERNS,
  DEFAULT_MAX_STEPS,
  HARD_CAP_MAX_STEPS,
} from './spec';

// ===========================================================================
// SYSTEM PROMPT — built once at module load.
// ===========================================================================
export const SYSTEM_SPEC_SYSTEM_PROMPT: string = (() => {
  const role =
    "You are the Aurexis Forge SYSTEM spec extractor. Your job is to read a user's natural-language intent and produce a precise, actionable SystemSpec — a multi-agent decomposition with a coordination pattern and named handoffs. Treat every field as a contract; downstream layers (orchestrator codegen, per-node codegen, sandbox) rely on it without re-asking the user. A SYSTEM is the right mold only when the work decomposes into TWO OR MORE coordinated sub-agents — a single-agent request is routed elsewhere by the caller.";

  const bar =
    'SPEC QUALITY BAR (' +
    specQualityBarVersionLabel('system') +
    ') — your output MUST satisfy every one of these:\n' +
    specQualityBarPromptBullets('system');

  const outputRules =
    'OUTPUT RULES — non-negotiable:\n' +
    '- Respond with a SINGLE JSON object — no prose before or after, no markdown code fences.\n' +
    '- The object MUST conform to the SystemSpec ExtractionResult schema shown below.\n' +
    '- Required fields MUST contain real content. Never emit placeholders ("TBD", "various", "any") — surface gaps via `open_questions` instead.';

  const schema =
    'SYSTEM SPEC EXTRACTION SCHEMA (target shape):\n' +
    '{\n' +
    '  "spec": {\n' +
    '    "goal": string,\n' +
    '    "sub_agents": [\n' +
    '      {\n' +
    '        "id": string,                            // lower_snake_case, unique within this spec\n' +
    '        "role": string,                          // short role name (e.g. "scraper", "summarizer")\n' +
    '        "description": string,                   // 1-2 sentences\n' +
    '        "inputs":  [string, ...],                // named payloads consumed (not "data")\n' +
    '        "outputs": [string, ...],                // named payloads produced (not "result")\n' +
    '        "tools":   [string, ...]                 // OPTIONAL — lower_snake_case tool ids\n' +
    '      },\n' +
    '      ...\n' +
    '    ],\n' +
    '    "coordination": {\n' +
    '      "pattern": "pipeline" | "fan_out_in" | "dag",\n' +
    '      "edges":   [{ "from": <sub_agent.id>, "to": <sub_agent.id> }, ...]\n' +
    '    },\n' +
    '    "triggers":  ["chat" | "api" | "schedule" | "webhook", ...],\n' +
    '    "max_steps": number                          // 1..' +
    HARD_CAP_MAX_STEPS +
    '; default ' +
    DEFAULT_MAX_STEPS +
    '\n' +
    '  },\n' +
    '  "open_questions": [string, ...]\n' +
    '}';

  return [role, '', bar, '', outputRules, '', schema].join('\n');
})();

// ===========================================================================
// CATALOG SLICE — COORDINATION_PATTERNS rendered for the prompt.
// ===========================================================================
function coordinationSlice(): string {
  return [
    'COORDINATION PATTERN CATALOG (the closed set of `coordination.pattern` values):',
    '  - pipeline   — strictly sequential A → B → C. edges may be omitted (implied by sub_agent declaration order).',
    '  - fan_out_in — one coordinator dispatches to N workers and aggregates their results. Use edges to describe the fan-out + fan-in shape.',
    '  - dag        — arbitrary directed acyclic graph. edges REQUIRED.',
    '',
    'Available patterns (use ONE): ' + COORDINATION_PATTERNS.join(', '),
  ].join('\n');
}

// ===========================================================================
// USER MESSAGE — structured context.
// ===========================================================================
export interface SystemExtractionUserMessageArgs {
  rawPrompt: string;
  answers?: ReadonlyArray<{ question: string; answer: string }>;
  refinements?: ReadonlyArray<string>;
}

export function buildSystemExtractionUserMessage(
  args: SystemExtractionUserMessageArgs,
): string {
  return [
    sectionIntent(args.rawPrompt),
    args.answers && args.answers.length > 0
      ? sectionClarifications(args.answers)
      : null,
    args.refinements && args.refinements.length > 0
      ? sectionRefinements(args.refinements)
      : null,
    coordinationSlice(),
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
    'Intent:   "Every Monday, gather the past-week\'s product feedback from Intercom, classify by theme, and summarise the top 3 themes in a Slack post."',
    '',
    'Good spec:',
    '{',
    '  "spec": {',
    '    "goal": "Weekly: pull last-7-day Intercom feedback, classify by theme, and post the top-3 themes to Slack.",',
    '    "sub_agents": [',
    '      {',
    '        "id": "gatherer",',
    '        "role": "Intercom feedback gatherer",',
    '        "description": "Pulls Intercom conversations from the last 7 days tagged as feedback.",',
    '        "inputs":  ["since_timestamp"],',
    '        "outputs": ["raw_conversations"],',
    '        "tools": ["http_request"]',
    '      },',
    '      {',
    '        "id": "classifier",',
    '        "role": "Theme classifier",',
    '        "description": "Assigns each conversation a theme label using an LLM, returns counts per theme.",',
    '        "inputs":  ["raw_conversations"],',
    '        "outputs": ["theme_counts"],',
    '        "tools": ["llm_completion"]',
    '      },',
    '      {',
    '        "id": "broadcaster",',
    '        "role": "Slack broadcaster",',
    '        "description": "Formats the top-3 themes into a Slack post and publishes it.",',
    '        "inputs":  ["theme_counts"],',
    '        "outputs": ["slack_message_ts"]',
    '      }',
    '    ],',
    '    "coordination": {',
    '      "pattern": "pipeline",',
    '      "edges": [',
    '        { "from": "gatherer",   "to": "classifier" },',
    '        { "from": "classifier", "to": "broadcaster" }',
    '      ]',
    '    },',
    '    "triggers": ["schedule"],',
    '    "max_steps": 12',
    '  },',
    '  "open_questions": []',
    '}',
    '',
    'Notice: three sub-agents with named handoffs (raw_conversations / theme_counts / slack_message_ts), explicit pipeline pattern, max_steps sized to the system (low, not the default 25).',
  ].join('\n');
}

function sectionFinalInstruction(): string {
  return [
    'PRODUCE THE EXTRACTION NOW',
    'Return ONLY the JSON object described above. No prose. No fences.',
  ].join('\n');
}

// ===========================================================================
// REPAIR MESSAGE — re-asserts the bar.
// ===========================================================================
export function buildSystemRepairUserMessage(error: string): string {
  return [
    'Your previous response could not be parsed: ' + error,
    '',
    'Return ONLY the corrected JSON object — no prose, no markdown code fences. Keep the spec content; fix the structure / fields that violated the schema. Continue to satisfy the SPEC QUALITY BAR (base + system addendum) you were given.',
  ].join('\n');
}
