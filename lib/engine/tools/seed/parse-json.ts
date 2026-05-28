// SEED TOOL — `parse_json`.
//
// Robust JSON extraction from arbitrary text. Mirrors the
// critique-gate's extractor pattern: handle fenced blocks, partial
// LLM responses, leading prose. Pure / local — no I/O.
//
// EXTRACTION ORDER
//   1. Try JSON.parse on the raw text.
//   2. Strip ```json ... ``` or ``` ... ``` fences, retry.
//   3. Find the first balanced { ... } or [ ... ] substring and
//      retry on that.
//   4. Give up — return parsed: null, recovered: false.
//
// `recovered` tracks whether step (2) or (3) had to kick in.

import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../contract';

// Shippable agent-side source — dependency-free. Self-mocks on
// FORGE_MOCK_TOOLS=1 for convention-consistency.
const SCAFFOLD_SOURCE = `import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface ParseJsonInput {
  text: string;
}
export interface ParseJsonOutput {
  parsed: unknown;
  recovered: boolean;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function stripFences(text: string): string {
  // Fence marker (three backticks) built without backtick literals so
  // this source survives being embedded in template strings.
  const FENCE = String.fromCharCode(96, 96, 96);
  const open = text.indexOf(FENCE);
  if (open < 0) return text;
  const nl = text.indexOf(String.fromCharCode(10), open);
  if (nl < 0) return text;
  const close = text.indexOf(FENCE, nl);
  if (close < 0) return text;
  return text.slice(nl + 1, close);
}

function findFirstOpen(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') return i;
  }
  return -1;
}

function firstBalancedJsonSubstring(text: string): string | null {
  const startIdx = findFirstOpen(text);
  if (startIdx < 0) return null;
  const open = text[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

export const parse_json: Tool<ParseJsonInput, ParseJsonOutput> = {
  id: 'parse_json',
  description: 'Extract structured JSON from arbitrary text.',
  async call({ text }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('parse_json.mock', { chars: text.length });
    }
    const direct = tryParse(text);
    if (direct.ok) return { parsed: direct.value, recovered: false };
    const stripped = stripFences(text);
    if (stripped !== text) {
      const r = tryParse(stripped);
      if (r.ok) return { parsed: r.value, recovered: true };
    }
    const candidate = firstBalancedJsonSubstring(text);
    if (candidate !== null) {
      const r = tryParse(candidate);
      if (r.ok) return { parsed: r.value, recovered: true };
    }
    return { parsed: null, recovered: false };
  },
};
`;

const SCAFFOLD_SIGNATURE =
  'export const parse_json:     Tool<{ text: string }, { parsed: unknown; recovered: boolean }>;';

const inputSchema = z.object({
  text: z.string(),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  parsed: z.unknown(),
  recovered: z.boolean(),
});
type Output = z.infer<typeof outputSchema>;

async function parseJson(input: Input, _ctx: ToolContext): Promise<Output> {
  // Pass 1: raw.
  const direct = tryParse(input.text);
  if (direct.ok) return { parsed: direct.value, recovered: false };

  // Pass 2: strip fences.
  const stripped = stripFences(input.text);
  if (stripped !== input.text) {
    const r = tryParse(stripped);
    if (r.ok) return { parsed: r.value, recovered: true };
  }

  // Pass 3: locate first balanced brace / bracket substring.
  const candidate = firstBalancedJsonSubstring(input.text);
  if (candidate !== null) {
    const r = tryParse(candidate);
    if (r.ok) return { parsed: r.value, recovered: true };
  }

  return { parsed: null, recovered: false };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Strip ```json ... ``` and bare ``` ... ``` fences. Returns the
 * input unchanged when no fence is detected.
 */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1] !== undefined) return fenced[1];
  return text;
}

/**
 * Find the first balanced `{...}` or `[...]` substring that parses
 * as JSON. Scans for the first `{` or `[`, then walks forward
 * tracking depth + string-state until the matching close.
 *
 * Returns null when no balanced substring exists.
 */
function firstBalancedJsonSubstring(text: string): string | null {
  const startIdx = findFirstOpen(text);
  if (startIdx < 0) return null;

  const open = text[startIdx]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function findFirstOpen(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') return i;
  }
  return -1;
}

export const PARSE_JSON: ToolDefinition<Input, Output> = {
  name: 'parse_json',
  description:
    'Extract structured JSON from arbitrary text. Handles raw JSON, ```json``` fenced blocks, ' +
    'and partial LLM responses with leading or trailing prose. Use when an agent receives a ' +
    'string that may or may not be wrapped JSON. Returns `parsed: null` when no JSON could be ' +
    'recovered; `recovered: true` indicates the parser had to strip fences or locate a brace ' +
    'substring.',
  category: 'parse',
  capabilities: {
    reads_network: false,
    writes_external: false,
    destructive: false,
  },
  input_schema: inputSchema,
  output_schema: outputSchema,
  runtime: parseJson,
  mock: parseJson,
  examples: [
    {
      label: 'pure JSON object',
      input: { text: '{"a":1,"b":2}' },
      output: { parsed: { a: 1, b: 2 }, recovered: false },
    },
    {
      label: 'fenced JSON in LLM response',
      input: {
        text: 'Here is the result:\n```json\n{"ok": true}\n```\nThanks!',
      },
      output: { parsed: { ok: true }, recovered: true },
    },
    {
      label: 'unrecoverable garbage',
      input: { text: 'no json here, just words' },
      output: { parsed: null, recovered: false },
    },
  ],
  scaffoldSource: SCAFFOLD_SOURCE,
  scaffoldInterfaceSignature: SCAFFOLD_SIGNATURE,
  plannerLabel: 'JSON extractor',
  envKeys: [],
  status: 'available',
};
