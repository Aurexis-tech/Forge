// EQUIVALENCE / BEHAVIOR-PRESERVATION — the crux of the tool-contract
// migration.
//
// Before migrating the 8 planner tools + scaffold into the engine
// tool contract, we captured an immutable baseline of the shipped
// scaffold + the planner registry into tests/fixtures/scaffold-
// baseline.json. After the migration, the DERIVED values MUST match
// that baseline exactly for the 8 existing tools:
//
//   1. Shipped scaffold source for the 8 tools — BYTE-IDENTICAL.
//   2. The src/lib/tools/index.ts barrel + tsconfig/package/README/
//      types/runtime boilerplate — BYTE-IDENTICAL.
//   3. SCAFFOLD_TOOL_INTERFACE — BYTE-IDENTICAL.
//   4. TOOL_REGISTRY entries for the 8 tools — FIELD-IDENTICAL.
//   5. The codegen TOOLS section for the 8 tools — RENDER-IDENTICAL
//      (assembled via the same renderTool path the prompt uses).
//
// A divergence here is a MIGRATION BUG to fix, not a snapshot to
// update.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCAFFOLD_FILES,
  SCAFFOLD_TOOL_INTERFACE,
} from '@/lib/engine/codegen/scaffold/agent-node-tool-using';
import { TOOL_REGISTRY } from '@/lib/engine/planner/registry';
import {
  buildCodegenUserMessage,
} from '@/lib/engine/codegen/prompts';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';

interface Baseline {
  scaffoldFiles: Array<{ path: string; content: string }>;
  scaffoldToolInterface: string;
  toolRegistry: Array<{
    id: string;
    label: string;
    description: string;
    env_keys: string[];
    status: string;
  }>;
}

const baseline: Baseline = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '..', 'fixtures', 'scaffold-baseline.json'),
    'utf8',
  ),
);

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

// ===========================================================================
// 1 + 2 — SCAFFOLD FILES BYTE-IDENTICAL
// ===========================================================================
describe('equivalence — shipped scaffold files', () => {
  it('the full SCAFFOLD_FILES set is byte-identical to the pre-migration baseline', () => {
    const post = SCAFFOLD_FILES.map((f) => ({ path: f.path, content: f.content }));
    expect(post).toEqual(baseline.scaffoldFiles);
  });

  it('each legacy tool source file ships byte-identical', () => {
    for (const name of LEGACY_TOOL_NAMES) {
      const filePath = 'src/lib/tools/' + name + '.ts';
      const pre = baseline.scaffoldFiles.find((f) => f.path === filePath);
      const post = SCAFFOLD_FILES.find((f) => f.path === filePath);
      expect(pre, 'baseline has ' + filePath).toBeDefined();
      expect(post, 'derived has ' + filePath).toBeDefined();
      expect(post!.content).toBe(pre!.content);
    }
  });

  it('the boilerplate files (package.json, tsconfig, README, types, index, runtime) are byte-identical', () => {
    for (const filePath of [
      'package.json',
      'tsconfig.json',
      'README.md',
      'src/lib/tools/types.ts',
      'src/lib/tools/index.ts',
      'src/lib/runtime.ts',
    ]) {
      const pre = baseline.scaffoldFiles.find((f) => f.path === filePath);
      const post = SCAFFOLD_FILES.find((f) => f.path === filePath);
      expect(post!.content, filePath + ' byte-identical').toBe(pre!.content);
    }
  });

  it('the file ORDER is unchanged', () => {
    expect(SCAFFOLD_FILES.map((f) => f.path)).toEqual(
      baseline.scaffoldFiles.map((f) => f.path),
    );
  });
});

// ===========================================================================
// 3 — SCAFFOLD_TOOL_INTERFACE BYTE-IDENTICAL
// ===========================================================================
describe('equivalence — SCAFFOLD_TOOL_INTERFACE', () => {
  it('the derived interface blob is byte-identical to the baseline', () => {
    expect(SCAFFOLD_TOOL_INTERFACE).toBe(baseline.scaffoldToolInterface);
  });
});

// ===========================================================================
// 4 — TOOL_REGISTRY entries field-identical for the 8 tools
// ===========================================================================
describe('equivalence — TOOL_REGISTRY entries (8 legacy tools)', () => {
  it('each legacy tool entry is field-identical pre/post (id/label/description/env_keys/status)', () => {
    for (const name of LEGACY_TOOL_NAMES) {
      const pre = baseline.toolRegistry.find((t) => t.id === name);
      const post = TOOL_REGISTRY.find((t) => t.id === name);
      expect(pre, 'baseline registry has ' + name).toBeDefined();
      expect(post, 'derived registry has ' + name).toBeDefined();
      expect({
        id: post!.id,
        label: post!.label,
        description: post!.description,
        env_keys: [...post!.env_keys],
        status: post!.status,
      }).toEqual(pre);
    }
  });

  it('the 8 legacy tools appear FIRST in the derived registry, in their original order', () => {
    const first8 = TOOL_REGISTRY.slice(0, 8).map((t) => t.id);
    expect(first8).toEqual(LEGACY_TOOL_NAMES);
  });
});

// ===========================================================================
// 5 — CODEGEN TOOLS SECTION render-identical
//
// The codegen TOOLS section is produced inside buildCodegenUserMessage
// via sectionTools()/renderTool() which read TOOL_REGISTRY. We render
// a message with a plan that uses the 8 tools and assert the per-tool
// TOOLS lines match what the pre-migration registry would have
// produced (reconstructed from the baseline registry entries with the
// same renderTool formatting).
// ===========================================================================

function reconstructToolLine(
  entry: { id: string; label: string; description: string; env_keys: string[] },
  why: string | null,
): string {
  const env =
    entry.env_keys.length === 0
      ? 'no env required'
      : 'env: ' + entry.env_keys.join(', ');
  const whyTail = why ? '  // why: ' + why : '';
  return (
    '  - ' + entry.id + '  [' + entry.label + '; ' + env + '] — ' + entry.description + whyTail
  );
}

describe('equivalence — codegen TOOLS section (8 legacy tools)', () => {
  it('every legacy tool renders the identical TOOLS line pre/post', () => {
    const spec: AgentSpec = AgentSpecSchema.parse({
      name: 'All Tools',
      goal: 'Exercise every legacy tool in one plan.',
      description: 'A synthetic agent that lists all 8 legacy tools.',
      trigger: 'schedule',
      runtime: 'on_demand',
      inputs: [{ name: 'x', description: 'input' }],
      capabilities: [
        { tool: 'web_search', why: 'why ws' },
        { tool: 'http_request', why: 'why http' },
        { tool: 'llm_completion', why: 'why llm' },
        { tool: 'file_read', why: 'why fr' },
        { tool: 'file_write', why: 'why fw' },
        { tool: 'schedule', why: 'why sch' },
        { tool: 'email_read', why: 'why er' },
        { tool: 'email_send', why: 'why es' },
      ],
      outputs: [{ name: 'y', description: 'output' }],
      constraints: [],
      success_criteria: ['done'],
      risk: 'low',
      confidence: 0.9,
    });
    const whyByTool: Record<string, string> = {
      web_search: 'why ws',
      http_request: 'why http',
      llm_completion: 'why llm',
      file_read: 'why fr',
      file_write: 'why fw',
      schedule: 'why sch',
      email_read: 'why er',
      email_send: 'why es',
    };
    const plan: BuildPlan = BuildPlanSchema.parse({
      scaffold: 'agent-node-tool-using',
      target: { framework: 'nodejs', hosting: 'vercel_function', entrypoint: 'src/index.ts' },
      trigger_impl: 'manual',
      runtime_impl: 'on_demand',
      tools: LEGACY_TOOL_NAMES.map((name) => {
        const entry = baseline.toolRegistry.find((t) => t.id === name)!;
        return {
          requested: name,
          status: entry.status === 'needs_key' ? 'needs_key' : 'supported',
          registry_id: name,
          env_keys: entry.env_keys,
        };
      }),
      files: [{ path: 'src/index.ts', purpose: 'entry' }],
      env_required: [],
      tasks: [{ id: 't', title: 't', description: 't', depends_on: [] }],
      estimate: { risk: 'low', complexity: 'low', notes: 'n' },
      warnings: [],
    });

    const message = buildCodegenUserMessage({
      spec,
      plan,
      toolInterface: 'stub',
      filePath: 'src/index.ts',
      filePurpose: 'entry',
      allFiles: [{ path: 'src/index.ts', purpose: 'entry', source: 'generated' }],
    });

    for (const name of LEGACY_TOOL_NAMES) {
      const entry = baseline.toolRegistry.find((t) => t.id === name)!;
      const expectedLine = reconstructToolLine(entry, whyByTool[name] ?? null);
      expect(message, 'TOOLS line for ' + name).toContain(expectedLine);
    }
  });
});
