// Hermetic integration test — the dependency-merge WIRING in
// generateCode.
//
// Proves the per-build package.json dependency merge actually fires
// in the real codegen pipeline (not just the pure helper):
//   - a build whose plan selects compute_math → package.json file
//     in the build output contains mathjs.
//   - a build with only the legacy tools → package.json byte-identical
//     to the scaffold base (no tool deps).
//
// Mocks: complete() (returns a trivial file) + staticCheckFile
// (returns ok). Both at the engine seam so the scaffold
// materialisation + merge run for real.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/engine/llm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/engine/llm')>(
    '@/lib/engine/llm',
  );
  return { ...actual, complete: vi.fn() };
});
vi.mock('@/lib/engine/codegen/staticcheck', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/engine/codegen/staticcheck')
  >('@/lib/engine/codegen/staticcheck');
  return { ...actual, staticCheckFile: vi.fn() };
});

import { generateCode } from '@/lib/engine/codegen/generate';
import { complete } from '@/lib/engine/llm';
import { staticCheckFile } from '@/lib/engine/codegen/staticcheck';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';
import { SCAFFOLD_FILES } from '@/lib/engine/codegen/scaffold/agent-node-tool-using';

const completeMock = complete as unknown as ReturnType<typeof vi.fn>;
const staticCheckMock = staticCheckFile as unknown as ReturnType<typeof vi.fn>;

const BASE_PACKAGE_JSON = SCAFFOLD_FILES.find((f) => f.path === 'package.json')!
  .content;

function makeSpec(capabilities: Array<{ tool: string; why: string }>): AgentSpec {
  return AgentSpecSchema.parse({
    name: 'Dep Merge Agent',
    goal: 'Exercise the dependency merge.',
    description: 'Synthetic agent for the dependency-merge wiring test.',
    trigger: 'schedule',
    runtime: 'on_demand',
    inputs: [{ name: 'x', description: 'input' }],
    capabilities,
    outputs: [{ name: 'y', description: 'output' }],
    constraints: [],
    success_criteria: ['done'],
    risk: 'low',
    confidence: 0.9,
  });
}

function makePlan(
  tools: Array<{ registry_id: string; env_keys?: string[]; status?: string }>,
): BuildPlan {
  return BuildPlanSchema.parse({
    scaffold: 'agent-node-tool-using',
    target: {
      framework: 'nodejs',
      hosting: 'vercel_function',
      entrypoint: 'src/index.ts',
    },
    trigger_impl: 'cron',
    runtime_impl: 'on_demand',
    tools: tools.map((t) => ({
      requested: t.registry_id,
      status: t.status ?? 'supported',
      registry_id: t.registry_id,
      env_keys: t.env_keys ?? [],
    })),
    files: [{ path: 'src/index.ts', purpose: 'entrypoint' }],
    env_required: [],
    tasks: [{ id: 't', title: 't', description: 't', depends_on: [] }],
    estimate: { risk: 'low', complexity: 'low', notes: 'n' },
    warnings: [],
  });
}

const governance = { user_id: 'u', project_id: 'p', ref: 'codegen.test' };

function primeMocks() {
  staticCheckMock.mockReset();
  staticCheckMock.mockResolvedValue({ ok: true });
  completeMock.mockReset();
  completeMock.mockResolvedValue({
    text: 'export const handler = async () => ({ ok: true });\n',
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'mock',
  });
}

describe('dependency-merge wiring — generateCode', () => {
  it('a build selecting compute_math ships mathjs in the package.json file', async () => {
    primeMocks();
    // Spec capabilities are lower_snake_case only; the dotted
    // compute_math registry_id rides on the PLAN's tools (which is
    // what the merge reads).
    const summary = await generateCode({
      spec: makeSpec([{ tool: 'http_request', why: 'fetch' }]),
      plan: makePlan([
        { registry_id: 'http_request' },
        { registry_id: 'compute_math' },
      ]),
      governance,
    });
    const pkgFile = summary.files.find((f) => f.path === 'package.json');
    expect(pkgFile, 'package.json present in build output').toBeDefined();
    const pkg = JSON.parse(pkgFile!.content) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.mathjs).toBe('^15.2.0');
    expect(pkg.dependencies['@anthropic-ai/sdk']).toBe('^0.40.0');
  });

  it('a build with only legacy tools ships a package.json byte-identical to the base', async () => {
    primeMocks();
    const summary = await generateCode({
      spec: makeSpec([
        { tool: 'http_request', why: 'fetch' },
        { tool: 'llm_completion', why: 'summarise' },
      ]),
      plan: makePlan([
        { registry_id: 'http_request' },
        { registry_id: 'llm_completion', env_keys: ['ANTHROPIC_API_KEY'] },
      ]),
      governance,
    });
    const pkgFile = summary.files.find((f) => f.path === 'package.json');
    expect(pkgFile!.content).toBe(BASE_PACKAGE_JSON);
    expect(pkgFile!.content).not.toContain('mathjs');
  });
});
