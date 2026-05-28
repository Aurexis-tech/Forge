// Hermetic — competing_experts judge generation via the EXISTING
// per-node path. Proves the judge node generates with (a) the
// judge-specific purpose and (b) a handoff contract consuming the N
// expert outputs. Mocks complete() + staticCheckFile at the engine
// seam (same pattern as codegen-critique-integration-dryrun).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return { ...actual, complete: vi.fn() };
});
vi.mock('@/lib/engine/codegen/staticcheck', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/engine/codegen/staticcheck')
  >();
  return { ...actual, staticCheckFile: vi.fn() };
});

import { complete } from '@/lib/engine/llm';
import { staticCheckFile } from '@/lib/engine/codegen/staticcheck';
import { generateOneSystemNodeModule } from '@/lib/engine/system/codegen/generate';
import { expandCoordination } from '@/lib/engine/system/coordination';
import { SystemSpecSchema, type SystemSpec } from '@/lib/engine/system/spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationNode,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';

const completeMock = complete as unknown as ReturnType<typeof vi.fn>;
const staticCheckMock = staticCheckFile as unknown as ReturnType<typeof vi.fn>;

function ceSpec(): SystemSpec {
  return SystemSpecSchema.parse({
    goal: 'Pick the best translation.',
    sub_agents: [
      { id: 'expert_a', role: 'Translator A', description: 'translates', inputs: ['text'], outputs: ['candidate_a'] },
      { id: 'expert_b', role: 'Translator B', description: 'translates', inputs: ['text'], outputs: ['candidate_b'] },
      { id: 'judge', role: 'judge', description: 'selects best', inputs: ['candidates'], outputs: ['best'] },
    ],
    coordination: { pattern: 'fan_out_in' },
    coordination_pattern: 'competing_experts',
    triggers: ['api'],
  });
}

// Build a valid competing_experts OrchestrationPlan from the expanded graph.
function cePlan(spec: SystemSpec): OrchestrationPlan {
  const graph = expandCoordination(spec);
  const nodes: OrchestrationNode[] = graph.nodeIds.map((id) => {
    const sub = spec.sub_agents.find((s) => s.id === id)!;
    const upstreams = graph.upstreamByNode[id] ?? [];
    const inputs =
      upstreams.length === 0
        ? [{ from: null, output: 'text' }]
        : upstreams.map((u) => ({
            from: u,
            output: spec.sub_agents.find((s) => s.id === u)?.outputs[0] ?? 'candidate',
          }));
    return {
      id,
      role: sub.role,
      task: 'do the work',
      inputs,
      outputs: sub.outputs,
      suggested_tools: [],
    };
  });
  return OrchestrationPlanSchema.parse({
    goal: spec.goal,
    pattern: spec.coordination.pattern,
    max_steps: spec.max_steps,
    nodes,
    edges: graph.edges,
    execution_order: graph.executionOrder,
    warnings: [],
  });
}

beforeEach(() => {
  completeMock.mockReset();
  staticCheckMock.mockReset();
  staticCheckMock.mockResolvedValue({ ok: true });
  completeMock.mockResolvedValue({
    text: 'export async function run(input) { return { best: input.candidate_a }; }\n',
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'mock',
  });
});

describe('competing_experts judge generation (existing per-node path)', () => {
  it('generates the judge with a JUDGE-specific purpose + a handoff contract consuming the expert outputs', async () => {
    const spec = ceSpec();
    const plan = cePlan(spec);
    const judge = plan.nodes.find((n) => n.id === 'judge')!;

    await generateOneSystemNodeModule({
      node: judge,
      spec,
      plan,
      governance: { user_id: 'u', project_id: 'p', ref: 'system.codegen' },
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    const userMessage = (completeMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    }).messages[0]!.content;

    // (a) judge-specific purpose framing.
    expect(userMessage).toContain('JUDGE node:');
    expect(userMessage).toMatch(/evaluate the candidate outputs/i);

    // (b) handoff contract consuming BOTH expert outputs.
    expect(userMessage).toContain('HANDOFF CONTRACT');
    expect(userMessage).toContain('expert_a');
    expect(userMessage).toContain('expert_b');
    expect(userMessage).toContain('candidate_a');
    expect(userMessage).toContain('candidate_b');
  });

  it('an EXPERT node generates with NO judge framing (additive — only judges change)', async () => {
    const spec = ceSpec();
    const plan = cePlan(spec);
    const expert = plan.nodes.find((n) => n.id === 'expert_a')!;

    await generateOneSystemNodeModule({
      node: expert,
      spec,
      plan,
      governance: { user_id: 'u', project_id: 'p', ref: 'system.codegen' },
    });

    const userMessage = (completeMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    }).messages[0]!.content;
    // The expert's OWN purpose line (the final GENERATE instruction)
    // carries NO judge framing. (The judge's purpose still appears in
    // the project file-list section — that's expected + correct.)
    expect(userMessage).toContain("Purpose: Module for node 'expert_a'");
    expect(userMessage).not.toContain("Purpose: JUDGE node:");
    // The expert consumes the external trigger payload, not expert outputs.
    expect(userMessage).toContain('external trigger');
  });
});
