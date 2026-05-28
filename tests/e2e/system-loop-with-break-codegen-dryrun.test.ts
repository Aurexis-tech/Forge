// Hermetic — loop_with_break per-node generation via the EXISTING
// per-node path. Proves (a) the CONTROLLER node generates with a
// controller-specific purpose + a continue/break control signal, and
// (b) the BODY ENTRY node's handoff contract surfaces the loop back edge
// (previous iteration's output feeds the next). Mocks complete() +
// staticCheckFile at the engine seam (same pattern as the
// competing-experts codegen dry-run).

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

function loopSpec(): SystemSpec {
  return SystemSpecSchema.parse({
    goal: 'Improve the draft until good enough.',
    sub_agents: [
      { id: 'body_0', role: 'Drafter', description: 'drafts', inputs: ['task'], outputs: ['draft'] },
      { id: 'body_1', role: 'Editor', description: 'edits', inputs: ['draft'], outputs: ['edited'] },
      { id: 'controller', role: 'controller', description: 'decides', inputs: ['edited'], outputs: ['decision'] },
    ],
    coordination: { pattern: 'pipeline' },
    coordination_pattern: 'loop_with_break',
    loop: { max_iterations: 4, break_condition: 'the edited draft needs no further changes' },
    triggers: ['api'],
  });
}

// Build a valid loop_with_break OrchestrationPlan (incl. loop metadata)
// from the expanded graph.
function loopPlan(spec: SystemSpec): OrchestrationPlan {
  const graph = expandCoordination(spec);
  const nodes: OrchestrationNode[] = graph.nodeIds.map((id) => {
    const sub = spec.sub_agents.find((s) => s.id === id)!;
    const upstreams = graph.upstreamByNode[id] ?? [];
    const inputs =
      upstreams.length === 0
        ? [{ from: null, output: 'task' }]
        : upstreams.map((u) => ({
            from: u,
            output: spec.sub_agents.find((s) => s.id === u)?.outputs[0] ?? 'handoff',
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
    loop: graph.loop,
  });
}

beforeEach(() => {
  completeMock.mockReset();
  staticCheckMock.mockReset();
  staticCheckMock.mockResolvedValue({ ok: true });
  completeMock.mockResolvedValue({
    text: "export async function run(input) { return { decision: 'continue' }; }\n",
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'mock',
  });
});

describe('loop_with_break generation (existing per-node path)', () => {
  it('generates the CONTROLLER with a controller-specific purpose + a continue/break control signal', async () => {
    const spec = loopSpec();
    const plan = loopPlan(spec);
    const controller = plan.nodes.find((n) => n.id === 'controller')!;

    await generateOneSystemNodeModule({
      node: controller,
      spec,
      plan,
      governance: { user_id: 'u', project_id: 'p', ref: 'system.codegen' },
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    const userMessage = (completeMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    }).messages[0]!.content;

    // (a) controller-specific framing.
    expect(userMessage).toContain('CONTROLLER node:');
    expect(userMessage).toMatch(/continue looping or stop/i);
    // (b) the structured control signal the runtime reads.
    expect(userMessage).toContain("'continue' | 'break'");
  });

  it("surfaces the loop BACK EDGE in the body entry node's handoff contract", async () => {
    const spec = loopSpec();
    const plan = loopPlan(spec);
    const bodyEntry = plan.nodes.find((n) => n.id === 'body_0')!;

    await generateOneSystemNodeModule({
      node: bodyEntry,
      spec,
      plan,
      governance: { user_id: 'u', project_id: 'p', ref: 'system.codegen' },
    });

    const userMessage = (completeMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    }).messages[0]!.content;

    expect(userMessage).toContain('HANDOFF CONTRACT');
    // The back edge: the previous iteration's terminal output (body_1)
    // feeds this entry node on iterations after the first.
    expect(userMessage).toContain('loop back-edge');
    expect(userMessage).toContain('body_1');
    // The body entry's OWN purpose carries NO controller framing. (The
    // controller's purpose still appears in the project file-list section
    // — that's expected + correct, mirroring the judge case.)
    expect(userMessage).toContain("Purpose: Module for node 'body_0'");
    expect(userMessage).not.toContain('Purpose: CONTROLLER node:');
  });
});
