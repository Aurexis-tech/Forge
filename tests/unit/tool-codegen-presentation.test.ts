// Codegen presentation tests — `toolsSectionForPrompt`.
//
// The section is the LLM-facing TOOLS+signatures block. It MUST
// be deterministic — byte-identical output for the same input
// list across runs, regardless of registration order.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  _resetRegistryForTests,
  _resetSeedFlagForTests,
  ensureSeedToolsRegistered,
  registerTool,
  renderToolBlock,
  toolsSectionForPrompt,
  UnknownToolError,
} from '@/lib/engine/tools';
import type { ToolDefinition } from '@/lib/engine/tools';

afterEach(() => {
  _resetRegistryForTests();
  _resetSeedFlagForTests();
  ensureSeedToolsRegistered();
});

function trivialTool(name: string): ToolDefinition {
  return {
    name,
    description: 'description for ' + name,
    category: 'compute',
    capabilities: { reads_network: false, writes_external: false, destructive: false },
    input_schema: z.object({ a: z.number() }),
    output_schema: z.object({ b: z.number() }),
    runtime: async (input) => ({ b: (input as { a: number }).a }),
    mock: async (input) => ({ b: (input as { a: number }).a }),
    examples: [
      { label: 'one', input: { a: 1 }, output: { b: 1 } },
      { label: 'two', input: { a: 2 }, output: { b: 2 } },
    ],
    scaffoldSource: 'export const x = 1;\n',
    scaffoldInterfaceSignature: 'export const ' + name.replace(/\./g, '_') + ': Tool<{ a: number }, { b: number }>;',
    plannerLabel: name,
    envKeys: [],
    status: 'available',
  };
}

// ===========================================================================
// EMPTY + UNKNOWN
// ===========================================================================
describe('toolsSectionForPrompt — empty + unknown', () => {
  it('returns a "none requested" stub for the empty input', () => {
    const section = toolsSectionForPrompt([]);
    expect(section).toContain('TOOLS AVAILABLE');
    expect(section).toContain('none requested');
  });

  it('throws UnknownToolError when any name is missing from the registry', () => {
    expect(() => toolsSectionForPrompt(['nope.absent'])).toThrow(UnknownToolError);
  });
});

// ===========================================================================
// DETERMINISM
// ===========================================================================
describe('toolsSectionForPrompt — determinism', () => {
  it('produces byte-identical output across 10 successive calls', () => {
    const names = ['compute_math', 'parse_json', 'compute_text_transform'];
    const first = toolsSectionForPrompt(names);
    for (let i = 0; i < 9; i++) {
      expect(toolsSectionForPrompt(names)).toBe(first);
    }
  });

  it('produces byte-identical output regardless of REGISTRATION order', () => {
    // Reset + register in two different orders; the same input
    // name list MUST produce the same section.
    _resetRegistryForTests();
    _resetSeedFlagForTests();
    registerTool(trivialTool('aa_x'));
    registerTool(trivialTool('bb_x'));
    const a = toolsSectionForPrompt(['aa_x', 'bb_x']);

    _resetRegistryForTests();
    _resetSeedFlagForTests();
    registerTool(trivialTool('bb_x'));
    registerTool(trivialTool('aa_x'));
    const b = toolsSectionForPrompt(['aa_x', 'bb_x']);

    expect(a).toBe(b);
  });

  it('preserves the INPUT name order in the rendered section', () => {
    _resetRegistryForTests();
    _resetSeedFlagForTests();
    registerTool(trivialTool('zzz_late'));
    registerTool(trivialTool('aaa_early'));
    const section = toolsSectionForPrompt(['zzz_late', 'aaa_early']);
    const zIdx = section.indexOf('zzz_late');
    const aIdx = section.indexOf('aaa_early');
    expect(zIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(-1);
    expect(zIdx).toBeLessThan(aIdx);
  });

  it('object keys are sorted in rendered input/output JSON so the block stays stable', () => {
    _resetRegistryForTests();
    _resetSeedFlagForTests();
    const t: ToolDefinition = {
      name: 'order_test',
      description: 'd',
      category: 'compute',
      capabilities: { reads_network: false, writes_external: false, destructive: false },
      input_schema: z.object({ zebra: z.number(), apple: z.number() }),
      output_schema: z.object({ delta: z.number(), bravo: z.number() }),
      runtime: async () => ({ delta: 1, bravo: 2 }),
      mock: async () => ({ delta: 1, bravo: 2 }),
      examples: [
        { label: 'one', input: { zebra: 9, apple: 1 }, output: { delta: 1, bravo: 2 } },
        { label: 'two', input: { zebra: 9, apple: 1 }, output: { delta: 1, bravo: 2 } },
      ],
      scaffoldSource: 'export const x = 1;\n',
      scaffoldInterfaceSignature: 'export const order_test: Tool<unknown, unknown>;',
      plannerLabel: 'Order test',
      envKeys: [],
      status: 'available',
    };
    registerTool(t);
    const section = toolsSectionForPrompt(['order_test']);
    // Keys MUST appear alphabetically (apple before zebra; bravo before delta).
    expect(section.indexOf('apple')).toBeLessThan(section.indexOf('zebra'));
    expect(section.indexOf('bravo')).toBeLessThan(section.indexOf('delta'));
  });
});

// ===========================================================================
// SHAPE OF EACH BLOCK
// ===========================================================================
describe('renderToolBlock — shape', () => {
  it('contains name, category, description, capabilities, input + output example', () => {
    const lines = renderToolBlock(trivialTool('shape_x'));
    const joined = lines.join('\n');
    expect(joined).toContain('shape_x');
    expect(joined).toContain('[compute]');
    expect(joined).toContain('description for shape_x');
    expect(joined).toContain('capabilities:');
    expect(joined).toContain('local'); // reads_network:false → "local"
    expect(joined).toContain('input  :');
    expect(joined).toContain('output :');
  });

  it("a network-reading tool's capabilities line says 'network'", () => {
    const t: ToolDefinition = {
      ...trivialTool('net_x'),
      capabilities: { reads_network: true, writes_external: false, destructive: false },
    };
    const joined = renderToolBlock(t).join('\n');
    expect(joined).toContain('network');
    expect(joined).not.toContain('local');
  });

  it('a destructive + writes_external tool surfaces both flags', () => {
    const t: ToolDefinition = {
      ...trivialTool('danger_x'),
      capabilities: { reads_network: false, writes_external: true, destructive: true },
    };
    const joined = renderToolBlock(t).join('\n');
    expect(joined).toContain('writes-external');
    expect(joined).toContain('destructive');
  });
});

// ===========================================================================
// END-TO-END — the seed tools render a complete section.
// ===========================================================================
describe('toolsSectionForPrompt — seed tools end-to-end', () => {
  it('the section for all three seed tools contains each name + category', () => {
    const section = toolsSectionForPrompt([
      'compute_math',
      'parse_json',
      'compute_text_transform',
    ]);
    expect(section).toContain('compute_math');
    expect(section).toContain('parse_json');
    expect(section).toContain('compute_text_transform');
    expect(section).toContain('[compute]');
    expect(section).toContain('[parse]');
    // All three are local-only, so the section should not surface 'network'.
    expect(section).not.toContain('network');
  });
});
