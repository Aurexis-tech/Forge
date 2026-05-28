// Prompts for the AGENT spec-extraction LLM calls.
//
// REFACTOR (spec-fidelity leg) — same shape as the codegen refactor:
//
//   - SYSTEM prompt now embeds the engine-owned SPEC_QUALITY_BAR
//     (lib/engine/spec/quality.ts) + the AGENT addendum verbatim,
//     so we INSTRUCT against the exact bar the eval harness MEASURES.
//
//   - USER message is a STRUCTURED set of clearly labelled sections
//     (INTENT / CLARIFICATIONS / REFINEMENTS / CATALOG SLICE / SCHEMA /
//     WORKED EXEMPLAR / FINAL INSTRUCTION) — not a single blob.
//
//   - WORKED EXEMPLAR: one short intent → good AgentSpec example that
//     visibly satisfies the bar.
//
//   - REPAIR message keeps its shape so the existing extractor's repair
//     retry loop works verbatim; re-asserts the bar.
//
// What did NOT change:
//
//   - The Zod schema (ExtractionResultSchema / AgentSpecSchema).
//   - The clarification loop's EXISTENCE (its quality is the next leg).
//   - The show-spec gate.
//   - Governance + ledger on every complete() call.
//   - The model default.

import { TOOL_REGISTRY } from '../planner/registry';
import {
  specQualityBarPromptBullets,
  specQualityBarVersionLabel,
} from './quality';

// ===========================================================================
// SYSTEM PROMPT — built once at module load.
// ===========================================================================
export const SPEC_SYSTEM_PROMPT: string = (() => {
  const role =
    'You are the Aurexis Forge AGENT spec extractor. Your job is to read a user\'s natural-language intent and produce a precise, actionable AgentSpec that downstream layers (planner, codegen, sandbox, runtime) can rely on without re-asking the user. Treat every field as a contract — the spec is the single source of truth for the build.';

  const bar =
    'SPEC QUALITY BAR (' +
    specQualityBarVersionLabel('agent') +
    ') — your output MUST satisfy every one of these:\n' +
    specQualityBarPromptBullets('agent');

  const outputRules =
    'OUTPUT RULES — non-negotiable:\n' +
    '- Respond with a SINGLE JSON object — no prose before or after, no markdown code fences.\n' +
    '- The object MUST conform to the AgentSpec ExtractionResult schema shown below.\n' +
    '- Required fields MUST contain real content. Do NOT emit placeholder strings ("TBD", "various", "any", "placeholder"). When you genuinely cannot decide, surface the gap via `open_questions` instead.\n' +
    '- Do NOT include markdown code fences in the response.';

  const schema =
    'AGENT SPEC EXTRACTION SCHEMA (target shape):\n' +
    '{\n' +
    '  "spec": {\n' +
    '    "name": string,                          // short product name, <= 60 chars\n' +
    '    "goal": string,                          // ONE sentence describing what the agent does\n' +
    '    "description": string,                   // 2-4 sentence summary\n' +
    '    "trigger": "chat" | "api" | "schedule" | "webhook",\n' +
    '    "runtime": "on_demand" | "always_on",\n' +
    '    "inputs":       [{ "name": string, "description": string }, ...],\n' +
    '    "capabilities": [{ "tool": string, "why": string }, ...],   // tool MUST be a registry id (see CATALOG SLICE)\n' +
    '    "outputs":      [{ "name": string, "description": string }, ...],\n' +
    '    "constraints":      [string, ...],\n' +
    '    "success_criteria": [string, ...],\n' +
    '    "risk": "low" | "medium" | "high",\n' +
    '    "confidence": number                     // 0..1, how complete this spec is\n' +
    '  },\n' +
    '  "open_questions": [string, ...]            // 1-3 SPECIFIC questions ONLY where intent is genuinely ambiguous; empty when clear\n' +
    '}';

  const triggerHelp =
    'TRIGGER PICKING:\n' +
    '- "schedule"  — "every morning", "daily", "weekly", "cron"\n' +
    '- "webhook"   — "when X happens externally", "on push", "on new email"\n' +
    '- "api"       — "an endpoint I can call", "from another service"\n' +
    '- "chat"      — anything else / direct user conversation';

  const riskHelp =
    'RISK PICKING:\n' +
    '- "high"   — sends real messages / spends money / writes to production systems\n' +
    '- "medium" — reads sensitive data, makes external API calls\n' +
    '- "low"    — pure read / summarisation / classification';

  return [role, '', bar, '', outputRules, '', schema, '', triggerHelp, '', riskHelp].join(
    '\n',
  );
})();

// ===========================================================================
// CATALOG SLICE — TOOL REGISTRY rendered compactly for the prompt.
// ===========================================================================
function toolRegistrySlice(): string {
  const lines = TOOL_REGISTRY.map((t) => {
    const env =
      t.env_keys.length === 0 ? 'no env' : 'env: ' + t.env_keys.join(', ');
    return (
      '  - ' +
      t.id +
      '  [' +
      t.status +
      '; ' +
      env +
      '] — ' +
      t.description
    );
  });
  return ['TOOL REGISTRY (the closed set of `capabilities[].tool` ids):', ...lines].join(
    '\n',
  );
}

// ===========================================================================
// USER MESSAGE — structured context.
// ===========================================================================
export interface ExtractionUserMessageArgs {
  rawPrompt: string;
  answers?: ReadonlyArray<{ question: string; answer: string }>;
  refinements?: ReadonlyArray<string>;
}

export function buildExtractionUserMessage(
  args: ExtractionUserMessageArgs,
): string {
  return [
    sectionIntent(args.rawPrompt),
    args.answers && args.answers.length > 0 ? sectionClarifications(args.answers) : null,
    args.refinements && args.refinements.length > 0
      ? sectionRefinements(args.refinements)
      : null,
    toolRegistrySlice(),
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
    'CLARIFICATIONS — the user has already answered these questions. Incorporate the answers into the spec. Do NOT ask the same questions again; open_questions should be empty unless something genuinely NEW is unclear.',
  ];
  for (const { question, answer } of answers) {
    lines.push('Q: ' + question);
    lines.push('A: ' + answer);
  }
  return lines.join('\n');
}

function sectionRefinements(refinements: ReadonlyArray<string>): string {
  const lines: string[] = [
    'USER REFINEMENTS — the user reviewed your previous draft and wants these changes applied precisely:',
  ];
  for (const r of refinements) lines.push('- ' + r);
  return lines.join('\n');
}

function sectionExemplar(): string {
  return [
    'WORKED EXEMPLAR (illustrative — DO NOT COPY VERBATIM; aim at this calibration of precision)',
    '',
    'Intent:   "Every morning, fetch the top items from Hacker News and email me a 5-bullet summary."',
    '',
    'Good spec:',
    '{',
    '  "spec": {',
    '    "name": "HN Morning Brief",',
    '    "goal": "Email a 5-bullet summary of the top Hacker News items every weekday morning.",',
    '    "description": "Runs on a schedule (08:00 local). Fetches the HN front page, extracts the top 5 items, summarises each in one sentence with the source link, and emails the result to the configured recipient.",',
    '    "trigger": "schedule",',
    '    "runtime": "on_demand",',
    '    "inputs": [',
    '      { "name": "recipient", "description": "Email address to deliver the brief to (configured env var)." }',
    '    ],',
    '    "capabilities": [',
    '      { "tool": "http_request",   "why": "Fetch the Hacker News front page." },',
    '      { "tool": "llm_completion", "why": "Compress each item to a one-sentence bullet." },',
    '      { "tool": "email_send",     "why": "Deliver the brief to the configured recipient." }',
    '    ],',
    '    "outputs": [',
    '      { "name": "brief_email_id", "description": "Provider message id of the delivered email." }',
    '    ],',
    '    "constraints": [',
    '      "Never send more than one brief per calendar day.",',
    '      "If the front page returns fewer than 5 items, send what is available and note the shortfall."',
    '    ],',
    '    "success_criteria": [',
    '      "A brief is delivered before 09:00 local on every weekday.",',
    '      "Every bullet links back to a real HN item URL."',
    '    ],',
    '    "risk": "medium",',
    '    "confidence": 0.92',
    '  },',
    '  "open_questions": []',
    '}',
    '',
    'Notice: concrete recipient name field, tool ids drawn from the registry, two observable success criteria, a real constraint about the shortfall edge case, no TBD placeholders.',
  ].join('\n');
}

function sectionFinalInstruction(): string {
  return [
    'PRODUCE THE EXTRACTION NOW',
    'Return ONLY the JSON object described above. No prose. No fences.',
  ].join('\n');
}

// ===========================================================================
// REPAIR MESSAGE — unchanged in shape; re-asserts the bar so the
// fix-up call still aims at the same calibration as the first pass.
// ===========================================================================
export function buildRepairUserMessage(error: string): string {
  return [
    'Your previous response could not be parsed: ' + error,
    '',
    'Return ONLY the corrected JSON object — no prose, no markdown code fences. Keep the spec content; fix the structure / fields that violated the schema. Continue to satisfy the SPEC QUALITY BAR you were given.',
  ].join('\n');
}
