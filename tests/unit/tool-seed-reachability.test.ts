// REACHABILITY — the 3 seed tools are now first-class, reachable by a
// real forge end-to-end as a RESULT of the contract migration:
//
//   - they appear in the DERIVED planner TOOL_REGISTRY (planner can
//     offer them),
//   - they render in the codegen TOOLS section (codegen describes them),
//   - they carry shippable scaffoldSource + correct scaffoldDependencies
//     (generated agents can run them — mathjs for compute_math).

import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, findRegistryTool } from '@/lib/engine/planner/registry';
import {
  getToolByName,
  toolsSectionForPrompt,
} from '@/lib/engine/tools';

const SEED_NAMES = [
  // batch 1
  'compute_math',
  'parse_json',
  'compute_text_transform',
  // batch 2
  'compute_regex_extract',
  'parse_url',
  'parse_csv',
];

// ===========================================================================
// PLANNER REGISTRY
// ===========================================================================
describe('reachability — seed tools in the derived planner registry', () => {
  it('every seed tool has a TOOL_REGISTRY entry the planner can ground against', () => {
    for (const name of SEED_NAMES) {
      const entry = findRegistryTool(name);
      expect(entry, name + ' is in TOOL_REGISTRY').toBeDefined();
      expect(entry!.id).toBe(name);
      expect(entry!.label.length).toBeGreaterThan(0);
      expect(Array.isArray(entry!.env_keys)).toBe(true);
      expect(['available', 'needs_key']).toContain(entry!.status);
    }
  });

  it('seed tools appear AFTER the 8 legacy tools (legacy order preserved at the head)', () => {
    const ids = TOOL_REGISTRY.map((t) => t.id);
    const firstSeedIdx = Math.min(
      ...SEED_NAMES.map((n) => ids.indexOf(n)),
    );
    expect(firstSeedIdx).toBeGreaterThanOrEqual(8);
  });
});

// ===========================================================================
// CODEGEN TOOLS SECTION
// ===========================================================================
describe('reachability — seed tools in the codegen TOOLS section', () => {
  it('toolsSectionForPrompt renders each seed tool with name + category', () => {
    const section = toolsSectionForPrompt(SEED_NAMES);
    for (const name of SEED_NAMES) expect(section).toContain(name);
    expect(section).toContain('[compute]');
    expect(section).toContain('[parse]');
  });
});

// ===========================================================================
// SHIPPABLE SCAFFOLD SOURCE + DEPENDENCIES
// ===========================================================================
describe('reachability — seed tools ship runnable scaffold source', () => {
  it('every seed tool has non-empty scaffoldSource + a signature line', () => {
    for (const name of SEED_NAMES) {
      const t = getToolByName(name);
      expect(t, name + ' registered').not.toBeNull();
      expect(t!.scaffoldSource.trim().length).toBeGreaterThan(0);
      expect(t!.scaffoldInterfaceSignature.trim().length).toBeGreaterThan(0);
      // The shipped source exports the tool under its JS-safe name.
      const stem = name.replace(/\./g, '_');
      expect(t!.scaffoldSource).toContain('export const ' + stem);
      // And self-mocks on the sandbox convention.
      expect(t!.scaffoldSource).toContain('isMockMode');
    }
  });

  it('compute_math declares mathjs as a scaffold dependency', () => {
    const t = getToolByName('compute_math');
    expect(t!.scaffoldDependencies).toBeDefined();
    expect(t!.scaffoldDependencies!.mathjs).toMatch(/^\^?\d+\./);
  });

  it('parse_csv declares papaparse as a scaffold dependency', () => {
    const t = getToolByName('parse_csv');
    expect(t!.scaffoldDependencies).toBeDefined();
    expect(t!.scaffoldDependencies!.papaparse).toMatch(/^\^?\d+\./);
  });

  it('the dependency-free tools declare no external deps', () => {
    for (const name of [
      'parse_json',
      'compute_text_transform',
      'compute_regex_extract',
      'parse_url',
    ]) {
      const t = getToolByName(name);
      const deps = t!.scaffoldDependencies ?? {};
      expect(Object.keys(deps)).toHaveLength(0);
    }
  });
});
