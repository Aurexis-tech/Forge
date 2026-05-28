// Sandbox bridge tests.
//
// The bridge is the SINGLE switch point between mock + runtime.
// Hermetic invariants:
//
//   1. mode='mock' dispatches to mock; runtime is NEVER touched.
//   2. mode='runtime' dispatches to runtime.
//   3. Missing mode defaults to 'mock' (fail-closed against
//      accidental real I/O).
//   4. Unknown tool name → UnknownToolError.
//   5. Input that fails input_schema → ToolSchemaError('input').
//   6. Runtime/mock returning a shape that fails output_schema →
//      ToolSchemaError('output').

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  _resetRegistryForTests,
  _resetSeedFlagForTests,
  callTool,
  ensureSeedToolsRegistered,
  registerTool,
  ToolSchemaError,
  UnknownToolError,
} from '@/lib/engine/tools';
import type { ToolDefinition } from '@/lib/engine/tools';

afterEach(() => {
  _resetRegistryForTests();
  _resetSeedFlagForTests();
  ensureSeedToolsRegistered();
});

interface Trace {
  runtimeCalls: number;
  mockCalls: number;
}

/**
 * Build a tracing tool that increments per-branch counters in a
 * shared trace object. Runtime branch is configured to THROW so
 * if the bridge ever picks runtime when mode='mock', the test
 * sees the explosion immediately.
 */
function tracingTool(opts: { runtimeMustNotFire?: boolean } = {}): {
  trace: Trace;
  def: ToolDefinition<{ x: number }, { y: number }>;
} {
  const trace: Trace = { runtimeCalls: 0, mockCalls: 0 };
  const def: ToolDefinition<{ x: number }, { y: number }> = {
    name: 'test_tracer',
    description: 'tracer',
    category: 'compute',
    capabilities: { reads_network: false, writes_external: false, destructive: false },
    input_schema: z.object({ x: z.number() }),
    output_schema: z.object({ y: z.number() }),
    runtime: async (input) => {
      trace.runtimeCalls++;
      if (opts.runtimeMustNotFire) {
        throw new Error('runtime branch must NEVER fire in mock-mode tests');
      }
      return { y: input.x * 10 };
    },
    mock: async (input) => {
      trace.mockCalls++;
      return { y: input.x };
    },
    examples: [
      { label: 'one', input: { x: 1 }, output: { y: 1 } },
      { label: 'two', input: { x: 2 }, output: { y: 2 } },
    ],
    scaffoldSource: 'export const tracer = 1;\n',
    scaffoldInterfaceSignature: 'export const test_tracer: Tool<{ x: number }, { y: number }>;',
    plannerLabel: 'Tracer',
    envKeys: [],
    status: 'available',
  };
  return { trace, def };
}

describe('sandbox bridge — mock-vs-runtime dispatch', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it("mode='mock' dispatches ONLY to mock; runtime is never touched (even when runtime would throw)", async () => {
    const { trace, def } = tracingTool({ runtimeMustNotFire: true });
    registerTool(def);
    const out = (await callTool({
      name: 'test_tracer',
      input: { x: 7 },
      mode: 'mock',
    })) as { y: number };
    expect(out.y).toBe(7); // mock returns x as-is
    expect(trace.mockCalls).toBe(1);
    expect(trace.runtimeCalls).toBe(0);
  });

  it("mode='runtime' dispatches ONLY to runtime", async () => {
    const { trace, def } = tracingTool();
    registerTool(def);
    const out = (await callTool({
      name: 'test_tracer',
      input: { x: 7 },
      mode: 'runtime',
    })) as { y: number };
    expect(out.y).toBe(70); // runtime multiplies by 10
    expect(trace.runtimeCalls).toBe(1);
    expect(trace.mockCalls).toBe(0);
  });

  it("missing mode defaults to 'mock' (fail-closed)", async () => {
    const { trace, def } = tracingTool({ runtimeMustNotFire: true });
    registerTool(def);
    // No mode flag — bridge MUST default to 'mock' so a forgetful
    // caller cannot accidentally fire real I/O.
    const out = (await callTool({ name: 'test_tracer', input: { x: 3 } })) as {
      y: number;
    };
    expect(out.y).toBe(3); // mock path
    expect(trace.runtimeCalls).toBe(0);
    expect(trace.mockCalls).toBe(1);
  });

  it('repeated mock calls stay in the mock branch — never escape', async () => {
    const { trace, def } = tracingTool({ runtimeMustNotFire: true });
    registerTool(def);
    for (let i = 0; i < 25; i++) {
      await callTool({ name: 'test_tracer', input: { x: i }, mode: 'mock' });
    }
    expect(trace.mockCalls).toBe(25);
    expect(trace.runtimeCalls).toBe(0);
  });
});

describe('sandbox bridge — error surfaces', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it('unknown tool name throws UnknownToolError', async () => {
    await expect(
      callTool({ name: 'does.not.exist', input: {}, mode: 'mock' }),
    ).rejects.toBeInstanceOf(UnknownToolError);
  });

  it('input that fails input_schema throws ToolSchemaError(direction="input")', async () => {
    const { def } = tracingTool();
    registerTool(def);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await callTool({ name: 'test_tracer', input: { x: 'not a number' as any }, mode: 'mock' });
      expect.fail('expected ToolSchemaError');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolSchemaError);
      expect((err as ToolSchemaError).direction).toBe('input');
    }
  });

  it('output that fails output_schema throws ToolSchemaError(direction="output")', async () => {
    const broken: ToolDefinition<{ x: number }, { y: number }> = {
      name: 'test_broken',
      description: 'returns a bad shape',
      category: 'compute',
      capabilities: { reads_network: false, writes_external: false, destructive: false },
      input_schema: z.object({ x: z.number() }),
      output_schema: z.object({ y: z.number() }),
      runtime: async () => ({ y: 'wrong type' as never }),
      mock: async () => ({ y: 'wrong type' as never }),
      examples: [
        // The validator only checks examples vs schema — these
        // examples are valid; the runtime/mock body is what
        // returns the bad shape.
        { label: 'a', input: { x: 1 }, output: { y: 1 } },
        { label: 'b', input: { x: 2 }, output: { y: 2 } },
      ],
      scaffoldSource: 'export const broken = 1;\n',
      scaffoldInterfaceSignature: 'export const test_broken: Tool<{ x: number }, { y: number }>;',
      plannerLabel: 'Broken',
      envKeys: [],
      status: 'available',
    };
    registerTool(broken);
    try {
      await callTool({ name: 'test_broken', input: { x: 1 }, mode: 'mock' });
      expect.fail('expected ToolSchemaError');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolSchemaError);
      expect((err as ToolSchemaError).direction).toBe('output');
    }
  });
});

// ===========================================================================
// HERMETICITY — confirms the bridge never fires real fetch through any
// seed tool when called in mock mode. The setup.ts fetch hard-blocker
// would explode if any seed runtime did a real call.
// ===========================================================================
describe('sandbox bridge — hermeticity for seed tools', () => {
  it('every seed tool in mock mode does not trigger the global fetch blocker', async () => {
    // If any of these accidentally falls through to a runtime that
    // calls fetch, the global setup.ts blocker throws
    // "real fetch() blocked" and the test fails.
    await callTool({ name: 'compute_math', input: { expression: '1+1' }, mode: 'mock' });
    await callTool({ name: 'parse_json', input: { text: '{"a":1}' }, mode: 'mock' });
    await callTool({
      name: 'compute_text_transform',
      input: { text: 'hello world', op: 'slug' },
      mode: 'mock',
    });
  });
});
