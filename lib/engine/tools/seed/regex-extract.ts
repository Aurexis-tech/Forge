// SEED TOOL — `compute_regex_extract`.
//
// Extract regex matches (+ capture groups) from text. Pure / local —
// no I/O, deterministic.
//
// ReDoS SAFETY (the required property: a pathological pattern must
// NOT hang): zero-dep defence in depth —
//   1. Hard caps on text + pattern length.
//   2. A catastrophic-pattern detector that rejects nested
//      quantifiers (the classic `(a+)+`, `(a*)*`, `(.*)+`, `(a{2,})+`
//      exponential-backtracking shapes) BEFORE any matching runs.
// A rejected pattern returns a typed bad_input EngineError, never a
// raw throw and never a hang.

import { z } from 'zod';
import { badInputError } from '../../errors';
import type { ToolContext, ToolDefinition } from '../contract';

const TEXT_MAX = 100_000;
const PATTERN_MAX = 1_000;

// Nested-quantifier detector: a group `(...)` whose body contains a
// quantifier (* + {), immediately followed by another quantifier.
// This is the dominant catastrophic-backtracking shape.
const CATASTROPHIC = /\([^()]*[*+{][^()]*\)[*+{]/;

const inputSchema = z.object({
  text: z.string(),
  pattern: z.string().min(1, 'pattern must be non-empty'),
  flags: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  matches: z.array(z.string()),
  groups: z.array(z.record(z.string())).optional(),
});
type Output = z.infer<typeof outputSchema>;

async function regexExtract(input: Input, _ctx: ToolContext): Promise<Output> {
  if (input.text.length > TEXT_MAX) {
    throw badInputError(
      'regex_input_too_large',
      'text exceeds ' + TEXT_MAX + ' chars (' + input.text.length + ')',
      'The input text is too large for safe regex extraction.',
    );
  }
  if (input.pattern.length > PATTERN_MAX) {
    throw badInputError(
      'regex_pattern_too_large',
      'pattern exceeds ' + PATTERN_MAX + ' chars',
      'The regex pattern is too long.',
    );
  }
  if (CATASTROPHIC.test(input.pattern)) {
    throw badInputError(
      'regex_catastrophic',
      'pattern rejected: nested quantifier (ReDoS risk): ' + input.pattern,
      'That regular expression could hang (catastrophic backtracking). ' +
        'Rewrite it without nested quantifiers like (a+)+.',
    );
  }

  const flags = input.flags ?? '';
  let re: RegExp;
  try {
    // Force global iteration so matchAll collects every match.
    re = new RegExp(input.pattern, flags.includes('g') ? flags : flags + 'g');
  } catch (err) {
    throw badInputError(
      'regex_invalid',
      'invalid regex: ' + (err instanceof Error ? err.message : String(err)),
      'The regular expression (or its flags) is invalid.',
    );
  }

  const matches: string[] = [];
  const groups: Array<Record<string, string>> = [];
  let sawGroups = false;

  for (const m of input.text.matchAll(re)) {
    matches.push(m[0]);
    const rec = recordForMatch(m);
    if (rec) {
      sawGroups = true;
      groups.push(rec);
    } else {
      groups.push({});
    }
  }

  return sawGroups ? { matches, groups } : { matches };
}

/**
 * Build the per-match group record: named groups when the pattern
 * has them, else numbered captures ("1", "2", …). Returns null when
 * the match has no capture groups at all.
 */
function recordForMatch(m: RegExpMatchArray): Record<string, string> | null {
  if (m.groups && Object.keys(m.groups).length > 0) {
    const rec: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.groups)) rec[k] = v ?? '';
    return rec;
  }
  if (m.length > 1) {
    const rec: Record<string, string> = {};
    for (let i = 1; i < m.length; i++) rec[String(i)] = m[i] ?? '';
    return rec;
  }
  return null;
}

const SCAFFOLD_SOURCE = `import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface RegexExtractInput {
  text: string;
  pattern: string;
  flags?: string;
}
export interface RegexExtractOutput {
  matches: string[];
  groups?: Array<Record<string, string>>;
}

const TEXT_MAX = 100000;
const PATTERN_MAX = 1000;
// Reject nested quantifiers (ReDoS) before matching.
const CATASTROPHIC = /\\([^()]*[*+{][^()]*\\)[*+{]/;

export const compute_regex_extract: Tool<RegexExtractInput, RegexExtractOutput> = {
  id: 'compute_regex_extract',
  description: 'Extract regex matches + capture groups from text (ReDoS-safe).',
  async call({ text, pattern, flags }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('compute_regex_extract.mock', { pattern });
    }
    if (text.length > TEXT_MAX) {
      throw new Error('[forge-agent] regex text too large');
    }
    if (pattern.length > PATTERN_MAX) {
      throw new Error('[forge-agent] regex pattern too large');
    }
    if (CATASTROPHIC.test(pattern)) {
      throw new Error('[forge-agent] regex rejected: catastrophic backtracking risk');
    }
    const f = flags ?? '';
    const re = new RegExp(pattern, f.includes('g') ? f : f + 'g');
    const matches: string[] = [];
    const groups: Array<Record<string, string>> = [];
    let sawGroups = false;
    for (const m of text.matchAll(re)) {
      matches.push(m[0]);
      const rec: Record<string, string> = {};
      if (m.groups && Object.keys(m.groups).length > 0) {
        for (const [k, v] of Object.entries(m.groups)) rec[k] = v ?? '';
        sawGroups = true;
      } else if (m.length > 1) {
        for (let i = 1; i < m.length; i++) rec[String(i)] = m[i] ?? '';
        sawGroups = true;
      }
      groups.push(rec);
    }
    return sawGroups ? { matches, groups } : { matches };
  },
};
`;

const SCAFFOLD_SIGNATURE =
  'export const compute_regex_extract: Tool<{ text: string; pattern: string; flags?: string }, { matches: string[]; groups?: Array<Record<string, string>> }>;';

export const COMPUTE_REGEX_EXTRACT: ToolDefinition<Input, Output> = {
  name: 'compute_regex_extract',
  description:
    'Extract regular-expression matches (and capture groups) from text. Use to pull ' +
    'structured fragments (ids, dates, tokens) out of strings. ReDoS-safe: catastrophic ' +
    'patterns are rejected with an error rather than hanging.',
  category: 'compute',
  capabilities: {
    reads_network: false,
    writes_external: false,
    destructive: false,
  },
  input_schema: inputSchema,
  output_schema: outputSchema,
  runtime: regexExtract,
  mock: regexExtract,
  examples: [
    {
      label: 'all digits',
      input: { text: 'a1 b2 c3', pattern: '\\d' },
      output: { matches: ['1', '2', '3'] },
    },
    {
      label: 'numbered capture group',
      input: { text: 'id=7 id=8', pattern: 'id=(\\d)' },
      output: { matches: ['id=7', 'id=8'], groups: [{ '1': '7' }, { '1': '8' }] },
    },
    {
      label: 'named capture groups',
      input: { text: 'a@b', pattern: '(?<user>\\w)@(?<host>\\w)' },
      output: { matches: ['a@b'], groups: [{ user: 'a', host: 'b' }] },
    },
  ],
  scaffoldSource: SCAFFOLD_SOURCE,
  scaffoldInterfaceSignature: SCAFFOLD_SIGNATURE,
  plannerLabel: 'Regex extractor',
  envKeys: [],
  status: 'available',
};
