// SEED TOOL — `compute.math`.
//
// Safe expression evaluator backed by mathjs. Pure / local — no
// network, no fs, no destructive side-effects. Mock + runtime
// share the same implementation (mathjs is deterministic and side-
// effect-free) so the sandbox bridge can dispatch either way
// without surprises.
//
// Defaults to mathjs's `evaluate` which supports:
//   - arithmetic: + - * / % ^
//   - functions:  sin, cos, log, sqrt, abs, round, floor, ceil
//   - constants:  pi, e
//   - parens:     grouping
//
// REFUSES anything that isn't a string. Returns `error` (not throws)
// when the expression is malformed — the LLM-facing contract is a
// total function so the agent can branch on `error` instead of
// catching exceptions in generated code.

import { evaluate } from 'mathjs';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../contract';

// Shippable agent-side source. Self-mocks on FORGE_MOCK_TOOLS=1 for
// convention-consistency even though mathjs is deterministic. Carries
// the mathjs dependency via scaffoldDependencies below.
const SCAFFOLD_SOURCE = `import { evaluate } from 'mathjs';
import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface ComputeMathInput {
  expression: string;
}
export interface ComputeMathOutput {
  value: number | string;
  error?: string;
}

export const compute_math: Tool<ComputeMathInput, ComputeMathOutput> = {
  id: 'compute.math',
  description: 'Evaluate a mathematical expression. Returns value or error.',
  async call({ expression }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('compute.math.mock', { expression });
    }
    try {
      const raw = evaluate(expression);
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) {
          return { value: String(raw), error: 'non-finite result' };
        }
        return { value: raw };
      }
      if (typeof raw === 'boolean') return { value: raw ? 1 : 0 };
      return { value: String(raw) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { value: '', error: msg };
    }
  },
};
`;

const SCAFFOLD_SIGNATURE =
  'export const compute_math:   Tool<{ expression: string }, { value: number | string; error?: string }>;';

const inputSchema = z.object({
  expression: z.string().min(1, 'expression must be non-empty'),
});
type Input = z.infer<typeof inputSchema>;

// Output is union-shaped: success carries `value`, failure carries
// `error`. Both fields are present in the type so the schema is
// total — easier for LLMs to handle than a sum type.
const outputSchema = z.object({
  value: z.union([z.number(), z.string()]),
  error: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

async function evaluateExpression(input: Input, _ctx: ToolContext): Promise<Output> {
  try {
    const raw = evaluate(input.expression);
    return normaliseResult(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Failure path: return an empty-string value + the error
    // message. Sticking to the same shape keeps downstream JSON
    // schema validation total.
    return { value: '', error: msg };
  }
}

/**
 * Normalise mathjs's wide return space to `number | string`. mathjs
 * can return BigNumber, Fraction, Complex, Matrix, etc.; we coerce
 * everything safely.
 */
function normaliseResult(raw: unknown): Output {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { value: String(raw), error: 'non-finite result' };
    }
    return { value: raw };
  }
  if (typeof raw === 'boolean') {
    return { value: raw ? 1 : 0 };
  }
  // Fall through: stringify everything else via mathjs's own format.
  // The mathjs `format()` helper would also work; toString() is
  // sufficient for our scope.
  return { value: String(raw) };
}

export const COMPUTE_MATH: ToolDefinition<Input, Output> = {
  name: 'compute.math',
  description:
    'Evaluate a mathematical expression (arithmetic, common functions, constants). ' +
    'Use when an agent needs to compute a numeric value from a formula. Returns the ' +
    'numeric result; sets `error` for malformed input.',
  category: 'compute',
  capabilities: {
    reads_network: false,
    writes_external: false,
    destructive: false,
  },
  input_schema: inputSchema,
  output_schema: outputSchema,
  // The runtime and mock share the same body — mathjs is pure +
  // deterministic, so we don't need a separate canned-data mock.
  // The single switch point (sandbox-bridge) still gates which
  // branch fires, which is what matters for the framework
  // invariants.
  runtime: evaluateExpression,
  mock: evaluateExpression,
  examples: [
    {
      label: 'simple sum',
      input: { expression: '2 + 3' },
      output: { value: 5 },
    },
    {
      label: 'function call',
      input: { expression: 'sqrt(16) + 1' },
      output: { value: 5 },
    },
    {
      label: 'malformed expression returns error',
      input: { expression: '2 + ' },
      output: { value: '', error: 'Value expected (char 5)' },
    },
  ],
  scaffoldSource: SCAFFOLD_SOURCE,
  scaffoldInterfaceSignature: SCAFFOLD_SIGNATURE,
  scaffoldDependencies: { mathjs: '^15.2.0' },
  plannerLabel: 'Math evaluator',
  envKeys: [],
  status: 'available',
};
