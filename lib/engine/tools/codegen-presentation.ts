// CODEGEN PRESENTATION — deterministic TOOLS+signatures section.
//
// `toolsSectionForPrompt(names)` builds the LLM-facing TOOLS
// section from the engine-internal registry. Distinct from the
// existing planner-registry-driven `sectionTools` in
// lib/engine/codegen/prompts.ts: this helper is the future-of-
// record for tools registered through the new contract. The two
// can co-exist; as planner tools migrate through the new
// registry, codegen prompts will delegate here.
//
// HARD INVARIANTS
//   - Output is DETERMINISTIC. Same input list = byte-identical
//     output. No timestamps, no random ordering, no Set
//     iteration.
//   - Unknown tool names THROW. The codegen path must never
//     silently drop a tool the prompt references; that breaks
//     the grounding contract.
//   - Signatures are derived from each tool's first example
//     (input + output shape) plus a capability summary. We do
//     NOT walk Zod internals — examples are the ground-truth
//     concrete instance the LLM can pattern-match against.
//
// USAGE
//   const section = toolsSectionForPrompt(['compute_math', 'parse_json']);

import type { ToolDefinition } from './contract';
import { getToolByName } from './registry';

/** Thrown when `toolsSectionForPrompt` is asked for a name the registry doesn't know. */
export class UnknownToolError extends Error {
  constructor(public readonly toolName: string) {
    super('no tool registered under name: ' + JSON.stringify(toolName));
    this.name = 'UnknownToolError';
  }
}

/**
 * Render the canonical TOOLS+signatures section for the given
 * list of registered tool names.
 *
 * The returned string is a complete section block — heading
 * included — that the caller pastes directly into the user
 * message of a codegen prompt.
 */
export function toolsSectionForPrompt(toolNames: ReadonlyArray<string>): string {
  if (toolNames.length === 0) {
    return [
      'TOOLS AVAILABLE',
      '  (none requested for this generation)',
    ].join('\n');
  }

  const tools = toolNames.map((n) => {
    const t = getToolByName(n);
    if (!t) throw new UnknownToolError(n);
    return t;
  });

  const lines: string[] = ['TOOLS AVAILABLE'];
  for (const t of tools) {
    lines.push(...renderToolBlock(t));
  }
  return lines.join('\n');
}

/**
 * Render a single tool. Public for tests so we can assert each
 * block's shape independently of the section frame.
 */
export function renderToolBlock(t: ToolDefinition): string[] {
  const example = t.examples[0]!; // registry guarantees ≥2 examples
  return [
    '  - ' + t.name + '  [' + t.category + ']: ' + t.description,
    '      capabilities: ' + summariseCapabilities(t),
    '      input  : ' + safeStringify(example.input),
    '      output : ' + safeStringify(example.output),
  ];
}

function summariseCapabilities(t: ToolDefinition): string {
  const tags: string[] = [];
  if (t.capabilities.reads_network) tags.push('network');
  else tags.push('local');
  if (t.capabilities.writes_external) tags.push('writes-external');
  if (t.capabilities.destructive) tags.push('destructive');
  return tags.join(' / ');
}

/**
 * Deterministic JSON stringify with stable key ordering so the
 * rendered section is byte-identical across runs regardless of
 * how the example object was constructed.
 */
function safeStringify(value: unknown): string {
  return JSON.stringify(value, replacerStableKeys(value));
}

function replacerStableKeys(_root: unknown): (key: string, value: unknown) => unknown {
  return (_key: string, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}
