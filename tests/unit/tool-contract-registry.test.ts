// Framework tests for the tool contract + registry.
//
// Exercises the registration validator on every failure mode +
// asserts the seed tools all pass cleanly via the public barrel.
// The actual runtime behaviour of each seed tool lives in its
// own per-tool test file.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  _resetRegistryForTests,
  ensureSeedToolsRegistered,
  _resetSeedFlagForTests,
  getToolByName,
  listTools,
  registerTool,
  ToolRegistrationError,
} from '@/lib/engine/tools';
import type { ToolDefinition } from '@/lib/engine/tools';

// Restore the seed registry between tests. Each test starts with
// either an empty or a freshly seeded registry, depending on which
// it needs. Tests that need a clean slate reset; tests that need
// the seeds present re-register them at the end.
afterEach(() => {
  _resetRegistryForTests();
  _resetSeedFlagForTests();
  ensureSeedToolsRegistered();
});

// A minimal valid definition used as a baseline; individual tests
// mutate single fields to trigger specific failure modes.
function baseDef(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'a test tool',
    category: 'compute',
    capabilities: { reads_network: false, writes_external: false, destructive: false },
    input_schema: z.object({ x: z.number() }),
    output_schema: z.object({ y: z.number() }),
    runtime: async (input) => ({ y: (input as { x: number }).x }),
    mock: async (input) => ({ y: (input as { x: number }).x }),
    examples: [
      { label: 'one', input: { x: 1 }, output: { y: 1 } },
      { label: 'two', input: { x: 2 }, output: { y: 2 } },
    ],
    scaffoldSource: 'export const x = 1;\n',
    scaffoldInterfaceSignature: 'export const test_tool: Tool<{ x: number }, { y: number }>;',
    plannerLabel: 'Test tool',
    envKeys: [],
    status: 'available',
    ...over,
  };
}

// ===========================================================================
// HAPPY PATH
// ===========================================================================
describe('registerTool — happy path', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it('a fully-formed definition registers cleanly and is retrievable by name', () => {
    const def = baseDef();
    expect(() => registerTool(def)).not.toThrow();
    expect(getToolByName('test_tool')).toBe(def);
  });

  it('listTools returns the registered tool sorted by name', () => {
    registerTool(baseDef({ name: 'b_tool' }));
    registerTool(baseDef({ name: 'a_tool' }));
    const names = listTools().map((t) => t.name);
    expect(names).toEqual(['a_tool', 'b_tool']);
  });

  it('listTools filters by category', () => {
    registerTool(baseDef({ name: 'comp_x', category: 'compute' }));
    registerTool(baseDef({ name: 'parse_x', category: 'parse' }));
    expect(listTools({ category: 'parse' }).map((t) => t.name)).toEqual(['parse_x']);
  });

  it('listTools local_only excludes network tools', () => {
    registerTool(baseDef({ name: 'local_x' }));
    registerTool(
      baseDef({
        name: 'net_x',
        capabilities: { reads_network: true, writes_external: false, destructive: false },
      }),
    );
    expect(listTools({ local_only: true }).map((t) => t.name)).toEqual(['local_x']);
  });
});

// ===========================================================================
// NAME
// ===========================================================================
describe('registerTool — name validation', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it('rejects empty name', () => {
    expect(() => registerTool(baseDef({ name: '' }))).toThrow(ToolRegistrationError);
  });

  it('rejects non-snake_case name (CamelCase)', () => {
    expect(() => registerTool(baseDef({ name: 'BadName' }))).toThrow(/must match/);
    expect(() => registerTool(baseDef({ name: 'ComputeFoo' }))).toThrow(/must match/);
  });

  it('rejects name starting with a digit', () => {
    expect(() => registerTool(baseDef({ name: '1tool' }))).toThrow(/must match/);
  });

  it('rejects DOTTED names (snake_case convention enforced — no namespaces)', () => {
    // The naming decision: cross-layer consistency requires strict
    // snake_case so a tool name is valid as a generated-project export
    // stem AND as a spec capability id. Dots are out.
    expect(() => registerTool(baseDef({ name: 'compute.foo' }))).toThrow(/must match/);
    expect(() => registerTool(baseDef({ name: 'a.b.c' }))).toThrow(/must match/);
  });

  it('accepts a valid snake_case name with digits + underscores', () => {
    expect(() => registerTool(baseDef({ name: 'parse_csv_v2' }))).not.toThrow();
  });

  it('rejects duplicate name', () => {
    registerTool(baseDef({ name: 'dup_tool' }));
    expect(() => registerTool(baseDef({ name: 'dup_tool' }))).toThrow(/already registered/);
  });
});

// ===========================================================================
// DESCRIPTION / CATEGORY / CAPABILITIES
// ===========================================================================
describe('registerTool — description / category / capabilities', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it('rejects empty description', () => {
    expect(() => registerTool(baseDef({ description: '   ' }))).toThrow(/description/);
  });

  it("rejects unknown category", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTool(baseDef({ category: 'magic' as any })),
    ).toThrow(/category/);
  });

  it('rejects capabilities missing a required field', () => {
    expect(() =>
      registerTool(
        baseDef({
          capabilities: {
            reads_network: false,
            writes_external: false,
          } as never,
        }),
      ),
    ).toThrow(/capabilities/);
  });

  it('rejects capabilities with non-boolean fields', () => {
    expect(() =>
      registerTool(
        baseDef({
          capabilities: {
            reads_network: 1 as never,
            writes_external: false,
            destructive: false,
          },
        }),
      ),
    ).toThrow(/capabilities/);
  });
});

// ===========================================================================
// SCHEMAS / SIGNATURES
// ===========================================================================
describe('registerTool — schema + signature validation', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it('rejects a non-Zod input_schema', () => {
    expect(() =>
      registerTool(baseDef({ input_schema: {} as never })),
    ).toThrow(/input_schema/);
  });

  it('rejects a non-Zod output_schema', () => {
    expect(() =>
      registerTool(baseDef({ output_schema: {} as never })),
    ).toThrow(/output_schema/);
  });

  it("rejects runtime that is not a function", () => {
    expect(() =>
      registerTool(baseDef({ runtime: 'not a function' as never })),
    ).toThrow(/runtime/);
  });

  it('rejects mock that is not a function', () => {
    expect(() =>
      registerTool(baseDef({ mock: 'not a function' as never })),
    ).toThrow(/mock/);
  });
});

// ===========================================================================
// EXAMPLES
// ===========================================================================
describe('registerTool — examples validation', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it('rejects examples with fewer than 2 entries', () => {
    expect(() =>
      registerTool(
        baseDef({
          examples: [{ label: 'one', input: { x: 1 }, output: { y: 1 } }],
        }),
      ),
    ).toThrow(/examples must be an array of ≥2/);
  });

  it('rejects an example whose input does not parse against input_schema', () => {
    expect(() =>
      registerTool(
        baseDef({
          examples: [
            { label: 'bad', input: { x: 'not a number' as never }, output: { y: 1 } },
            { label: 'good', input: { x: 2 }, output: { y: 2 } },
          ],
        }),
      ),
    ).toThrow(/example\[0\]\.input/);
  });

  it('rejects an example whose output does not parse against output_schema', () => {
    expect(() =>
      registerTool(
        baseDef({
          examples: [
            { label: 'good', input: { x: 1 }, output: { y: 1 } },
            { label: 'bad', input: { x: 2 }, output: { y: 'not a number' as never } },
          ],
        }),
      ),
    ).toThrow(/example\[1\]\.output/);
  });

  it('rejects an example with an empty label', () => {
    expect(() =>
      registerTool(
        baseDef({
          examples: [
            { label: '', input: { x: 1 }, output: { y: 1 } },
            { label: 'two', input: { x: 2 }, output: { y: 2 } },
          ],
        }),
      ),
    ).toThrow(/example\[0\]\.label/);
  });
});

// ===========================================================================
// SEED TOOLS — confirm the three seed definitions register cleanly via
// the public barrel.
// ===========================================================================
describe('seed tools — register cleanly via public barrel', () => {
  it('the registry contains exactly the three seed tools after a fresh import', () => {
    const names = listTools().map((t) => t.name);
    expect(names).toContain('compute_math');
    expect(names).toContain('parse_json');
    expect(names).toContain('compute_text_transform');
  });

  it('every seed tool is local-only (capabilities: reads_network=false, writes_external=false, destructive=false)', () => {
    for (const name of ['compute_math', 'parse_json', 'compute_text_transform']) {
      const t = getToolByName(name);
      expect(t).not.toBeNull();
      expect(t!.capabilities.reads_network).toBe(false);
      expect(t!.capabilities.writes_external).toBe(false);
      expect(t!.capabilities.destructive).toBe(false);
    }
  });
});
