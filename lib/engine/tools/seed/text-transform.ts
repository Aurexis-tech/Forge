// SEED TOOL — `compute_text_transform`.
//
// Deterministic text operations: slug, kebab-case, snake-case,
// title-case, truncate, normalize-whitespace. Pure / local — no
// I/O.
//
// Each operation is a small pure function; the runtime + mock
// share the same implementation. The `op` parameter is closed:
// unknown ops fall through to a structured error (returned in
// `result` shaped as the error message prefixed with "ERROR: ").
// This keeps the contract total so LLM-generated agents can
// branch on prefix rather than catch exceptions.

import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../contract';

// Shippable agent-side source — dependency-free. Self-mocks on
// FORGE_MOCK_TOOLS=1 for convention-consistency.
const SCAFFOLD_SOURCE = `import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface TextTransformInput {
  text: string;
  op: 'slug' | 'kebab' | 'snake' | 'title' | 'truncate' | 'normalize_whitespace';
  params?: Record<string, unknown>;
}
export interface TextTransformOutput {
  result: string;
}

function splitWords(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 0);
}

function toSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .replace(/['\\u2018\\u2019]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const compute_text_transform: Tool<TextTransformInput, TextTransformOutput> = {
  id: 'compute_text_transform',
  description: 'Apply a deterministic text transformation.',
  async call({ text, op, params }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('compute_text_transform.mock', { op });
    }
    switch (op) {
      case 'slug':
        return { result: toSlug(text) };
      case 'kebab':
        return { result: splitWords(text).map((w) => w.toLowerCase()).join('-') };
      case 'snake':
        return { result: splitWords(text).map((w) => w.toLowerCase()).join('_') };
      case 'title':
        return {
          result: splitWords(text)
            .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
            .join(' '),
        };
      case 'truncate': {
        const maxLen = typeof params?.max_length === 'number' ? params.max_length : 80;
        const suffix = typeof params?.suffix === 'string' ? params.suffix : '\\u2026';
        if (text.length <= maxLen) return { result: text };
        return { result: text.slice(0, Math.max(0, maxLen - suffix.length)) + suffix };
      }
      case 'normalize_whitespace':
        return { result: text.replace(/\\s+/g, ' ').trim() };
      default:
        return { result: 'ERROR: unknown op' };
    }
  },
};
`;

const SCAFFOLD_SIGNATURE =
  "export const compute_text_transform: Tool<{ text: string; op: 'slug'|'kebab'|'snake'|'title'|'truncate'|'normalize_whitespace'; params?: Record<string, unknown> }, { result: string }>;";

export const TEXT_OPS = [
  'slug',
  'kebab',
  'snake',
  'title',
  'truncate',
  'normalize_whitespace',
] as const;
export type TextOp = (typeof TEXT_OPS)[number];

const inputSchema = z.object({
  text: z.string(),
  op: z.enum(TEXT_OPS),
  // Per-op parameters. Currently only `truncate` reads it.
  params: z.record(z.unknown()).optional(),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  result: z.string(),
});
type Output = z.infer<typeof outputSchema>;

async function transform(input: Input, _ctx: ToolContext): Promise<Output> {
  switch (input.op) {
    case 'slug':
      return { result: toSlug(input.text) };
    case 'kebab':
      return { result: toKebab(input.text) };
    case 'snake':
      return { result: toSnake(input.text) };
    case 'title':
      return { result: toTitle(input.text) };
    case 'truncate':
      return { result: truncate(input.text, input.params) };
    case 'normalize_whitespace':
      return { result: normaliseWhitespace(input.text) };
    default: {
      // Exhaustiveness — Zod enum already enforces this, but the
      // explicit default keeps the contract total at runtime.
      const _exhaustive: never = input.op;
      return { result: 'ERROR: unknown op ' + JSON.stringify(_exhaustive) };
    }
  }
}

// ---------------------------------------------------------------------------
// Op implementations — small pure functions.
// ---------------------------------------------------------------------------

/** URL-safe slug: lowercase, ASCII alnum + dashes, collapsed. */
export function toSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/['‘’]/g, '') // strip ASCII + smart apostrophes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** kebab-case: words separated by single dashes; preserves only alnum. */
export function toKebab(s: string): string {
  return splitWords(s).map((w) => w.toLowerCase()).join('-');
}

/** snake_case: words separated by single underscores; preserves only alnum. */
export function toSnake(s: string): string {
  return splitWords(s).map((w) => w.toLowerCase()).join('_');
}

/** Title Case: capitalises the first letter of each word. */
export function toTitle(s: string): string {
  return splitWords(s)
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * Truncate to params.max_length characters; append params.suffix
 * (default '…') if any characters were cut.
 */
export function truncate(s: string, params: Record<string, unknown> | undefined): string {
  const maxLen = typeof params?.max_length === 'number' ? params.max_length : 80;
  const suffix = typeof params?.suffix === 'string' ? params.suffix : '…';
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - suffix.length)) + suffix;
}

/** Collapse runs of whitespace to a single space; trim ends. */
export function normaliseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Split a string into alphanumeric "words" via every non-alnum
 * separator. Used by kebab/snake/title.
 */
function splitWords(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 0);
}

export const COMPUTE_TEXT_TRANSFORM: ToolDefinition<Input, Output> = {
  name: 'compute_text_transform',
  description:
    'Apply a deterministic text transformation: slug, kebab, snake, title, truncate, ' +
    'normalize_whitespace. Use for ID generation, slug creation, normalising user input, ' +
    'and similar pure-string operations. `truncate` reads params.max_length (default 80) ' +
    'and params.suffix (default "…").',
  category: 'compute',
  capabilities: {
    reads_network: false,
    writes_external: false,
    destructive: false,
  },
  input_schema: inputSchema,
  output_schema: outputSchema,
  runtime: transform,
  mock: transform,
  examples: [
    {
      label: 'slug',
      input: { text: "O'Reilly's Café  & Co.", op: 'slug' },
      output: { result: 'oreillys-cafe-co' },
    },
    {
      label: 'title case',
      input: { text: 'hello world from the forge', op: 'title' },
      output: { result: 'Hello World From The Forge' },
    },
    {
      label: 'truncate with custom suffix',
      input: {
        text: 'The quick brown fox jumps over the lazy dog',
        op: 'truncate',
        params: { max_length: 20, suffix: '...' },
      },
      output: { result: 'The quick brown f...' },
    },
  ],
  scaffoldSource: SCAFFOLD_SOURCE,
  scaffoldInterfaceSignature: SCAFFOLD_SIGNATURE,
  plannerLabel: 'Text transform',
  envKeys: [],
  status: 'available',
};
