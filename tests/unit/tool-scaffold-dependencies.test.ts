// Scaffold dependency merge — the gap-closer that makes a tool's
// scaffoldDependencies land in the generated project's package.json.
//
// Tests the PURE merge helpers against the REAL base package.json
// (read from SCAFFOLD_FILES) + the REAL registered tools, plus the
// conflict rule with synthetic fixtures.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  _resetRegistryForTests,
  _resetSeedFlagForTests,
  collectToolDependencies,
  dedupeSelectedToolNames,
  ensureToolsRegistered,
  mergePackageJsonDependencies,
  registerTool,
} from '@/lib/engine/tools';
import type { ToolDefinition } from '@/lib/engine/tools';
import { EngineError } from '@/lib/engine/errors';
import { SCAFFOLD_FILES } from '@/lib/engine/codegen/scaffold/agent-node-tool-using';

// The real, current base package.json shipped by the scaffold.
const BASE_PACKAGE_JSON = SCAFFOLD_FILES.find((f) => f.path === 'package.json')!
  .content;

const LEGACY_TOOL_NAMES = [
  'web_search',
  'http_request',
  'llm_completion',
  'file_read',
  'file_write',
  'schedule',
  'email_read',
  'email_send',
];

afterEach(() => {
  _resetRegistryForTests();
  _resetSeedFlagForTests();
  ensureToolsRegistered();
});

// ===========================================================================
// COMPUTE.MATH SHIPS MATHJS
// ===========================================================================
describe('mergePackageJsonDependencies — compute.math ships mathjs', () => {
  it('a build selecting compute.math gets mathjs in package.json at the declared version', () => {
    const merged = mergePackageJsonDependencies(BASE_PACKAGE_JSON, [
      'compute.math',
    ]);
    const pkg = JSON.parse(merged) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.mathjs).toBe('^15.2.0');
  });

  it('the base @anthropic-ai/sdk dependency is still present alongside mathjs', () => {
    const merged = mergePackageJsonDependencies(BASE_PACKAGE_JSON, [
      'compute.math',
    ]);
    const pkg = JSON.parse(merged) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@anthropic-ai/sdk']).toBe('^0.40.0');
    expect(pkg.dependencies.mathjs).toBe('^15.2.0');
  });
});

// ===========================================================================
// EXCLUDING COMPUTE.MATH → NO MATHJS
// ===========================================================================
describe('mergePackageJsonDependencies — no math, no mathjs', () => {
  it('a build that excludes compute.math has NO mathjs', () => {
    const merged = mergePackageJsonDependencies(BASE_PACKAGE_JSON, [
      'http_request',
      'llm_completion',
    ]);
    expect(merged).not.toContain('mathjs');
  });

  it('dependency-free tools (parse.json, text_transform) add nothing', () => {
    const merged = mergePackageJsonDependencies(BASE_PACKAGE_JSON, [
      'parse.json',
      'compute.text_transform',
    ]);
    // Identical to a build with no tool deps at all.
    expect(merged).toBe(mergePackageJsonDependencies(BASE_PACKAGE_JSON, []));
    expect(merged).not.toContain('mathjs');
  });
});

// ===========================================================================
// BASE DEPS ALWAYS PRESENT
// ===========================================================================
describe('mergePackageJsonDependencies — base deps always present', () => {
  it('@anthropic-ai/sdk + devDeps survive every tool selection', () => {
    for (const sel of [
      [] as string[],
      ['compute.math'],
      ['parse.json', 'compute.text_transform'],
      LEGACY_TOOL_NAMES,
      [...LEGACY_TOOL_NAMES, 'compute.math'],
    ]) {
      const merged = mergePackageJsonDependencies(BASE_PACKAGE_JSON, sel);
      const pkg = JSON.parse(merged) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(pkg.dependencies['@anthropic-ai/sdk']).toBe('^0.40.0');
      expect(pkg.devDependencies['@types/node']).toBe('^20.16.10');
      expect(pkg.devDependencies.tsx).toBe('^4.19.1');
      expect(pkg.devDependencies.typescript).toBe('^5.6.2');
    }
  });
});

// ===========================================================================
// LEGACY ANCHOR — byte-identity
// ===========================================================================
describe('mergePackageJsonDependencies — legacy byte-identity', () => {
  it('an 8-legacy-tool build produces a package.json BYTE-IDENTICAL to the base', () => {
    const merged = mergePackageJsonDependencies(
      BASE_PACKAGE_JSON,
      LEGACY_TOOL_NAMES,
    );
    expect(merged).toBe(BASE_PACKAGE_JSON);
  });

  it('a no-tool build is also byte-identical to the base', () => {
    expect(mergePackageJsonDependencies(BASE_PACKAGE_JSON, [])).toBe(
      BASE_PACKAGE_JSON,
    );
  });
});

// ===========================================================================
// STABLE KEY ORDERING
// ===========================================================================
describe('mergePackageJsonDependencies — stable ordering', () => {
  it('the same selected-tool set yields byte-identical output across calls', () => {
    const a = mergePackageJsonDependencies(BASE_PACKAGE_JSON, ['compute.math']);
    const b = mergePackageJsonDependencies(BASE_PACKAGE_JSON, ['compute.math']);
    expect(a).toBe(b);
  });

  it('selection ORDER does not change the output (deps sorted)', () => {
    const a = mergePackageJsonDependencies(BASE_PACKAGE_JSON, [
      'compute.math',
      'parse.json',
    ]);
    const b = mergePackageJsonDependencies(BASE_PACKAGE_JSON, [
      'parse.json',
      'compute.math',
    ]);
    expect(a).toBe(b);
  });

  it('dependencies are sorted alphabetically (@anthropic-ai/sdk before mathjs)', () => {
    const merged = mergePackageJsonDependencies(BASE_PACKAGE_JSON, [
      'compute.math',
    ]);
    expect(merged.indexOf('@anthropic-ai/sdk')).toBeLessThan(
      merged.indexOf('mathjs'),
    );
  });

  it('the output is valid JSON ending with a single trailing newline', () => {
    const merged = mergePackageJsonDependencies(BASE_PACKAGE_JSON, [
      'compute.math',
    ]);
    expect(() => JSON.parse(merged)).not.toThrow();
    expect(merged.endsWith('}\n')).toBe(true);
    expect(merged.endsWith('}\n\n')).toBe(false);
  });
});

// ===========================================================================
// VERSION CONFLICT RULE
// ===========================================================================
describe('collectToolDependencies — version conflict fails loudly', () => {
  function depTool(name: string, deps: Record<string, string>): ToolDefinition {
    return {
      name,
      description: 'synthetic conflict fixture ' + name,
      category: 'compute',
      capabilities: { reads_network: false, writes_external: false, destructive: false },
      input_schema: z.object({}),
      output_schema: z.object({}),
      runtime: async () => ({}),
      mock: async () => ({}),
      examples: [
        { label: 'a', input: {}, output: {} },
        { label: 'b', input: {}, output: {} },
      ],
      scaffoldSource: 'export const x = 1;\n',
      scaffoldInterfaceSignature: 'export const ' + name.replace(/\./g, '_') + ': unknown;',
      scaffoldDependencies: deps,
      plannerLabel: name,
      envKeys: [],
      status: 'available',
    };
  }

  beforeEach(() => {
    _resetRegistryForTests();
    _resetSeedFlagForTests();
  });

  it('two tools declaring the same package at DIFFERENT versions throws bad_input/tool_dependency_conflict', () => {
    registerTool(depTool('conflict.a', { leftpad: '^1.0.0' }));
    registerTool(depTool('conflict.b', { leftpad: '^2.0.0' }));
    try {
      collectToolDependencies(['conflict.a', 'conflict.b']);
      expect.fail('expected a conflict error');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe('tool_dependency_conflict');
    }
  });

  it('two tools declaring the same package at the SAME version dedupe cleanly', () => {
    registerTool(depTool('same.a', { leftpad: '^1.0.0' }));
    registerTool(depTool('same.b', { leftpad: '^1.0.0' }));
    const deps = collectToolDependencies(['same.a', 'same.b']);
    expect(deps).toEqual({ leftpad: '^1.0.0' });
  });

  it('the conflict surfaces through mergePackageJsonDependencies too', () => {
    registerTool(depTool('m.a', { leftpad: '^1.0.0' }));
    registerTool(depTool('m.b', { leftpad: '^2.0.0' }));
    try {
      mergePackageJsonDependencies(BASE_PACKAGE_JSON, ['m.a', 'm.b']);
      expect.fail('expected a conflict error');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('tool_dependency_conflict');
    }
  });

  it('unknown tool names contribute no deps (skipped, not thrown)', () => {
    expect(collectToolDependencies(['does.not.exist'])).toEqual({});
  });
});

// ===========================================================================
// SELECTION DEDUP HELPER
// ===========================================================================
describe('dedupeSelectedToolNames', () => {
  it('drops nulls + duplicates, preserving first-seen order', () => {
    expect(
      dedupeSelectedToolNames(['a', null, 'b', 'a', null, 'c', 'b']),
    ).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for an all-null list', () => {
    expect(dedupeSelectedToolNames([null, null])).toEqual([]);
  });
});
