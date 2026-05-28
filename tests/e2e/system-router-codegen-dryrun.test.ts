// Hermetic — router per-node generation via the EXISTING per-node path.
// Proves (a) the ROUTER node generates with a router-specific purpose that
// lists the VALID branch keys + a { branch: <key> } control signal, and
// (b) a BRANCH node generates normally (no router framing). Mocks
// complete() + staticCheckFile at the engine seam (same pattern as the
// loop / competing-experts codegen dry-runs).

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

function routerSpec(): SystemSpec {
  return SystemSpecSchema.parse({
    goal: 'Route the support ticket to the right team.',
    sub_agents: [
      { id: 'route', role: 'router', description: 'classifies the ticket', inputs: ['ticket'], outputs: ['routed'] },
      { id: 'billing', role: 'Billing handler', description: 'handles billing', inputs: ['routed'], outputs: ['reply'] },
      { id: 'tech', role: 'Tech handler', description: 'handles technical', inputs: ['routed'], outputs: ['reply'] },
    ],
    coordination: { pattern: 'fan_out_in' },
    coordination_pattern: 'router',
    router: {
      branches: [
        { key: 'billing', node_ids: ['billing'] },
        { key: 'technical', node_ids: ['tech'] },
      ],
    },
    triggers: ['api'],
  });
}

function routerPlan(spec: SystemSpec): OrchestrationPlan {
  const graph = expandCoordination(spec);
  const nodes: OrchestrationNode[] = graph.nodeIds.map((id) => {
    const sub = spec.sub_agents.find((s) => s.id === id)!;
    const upstreams = graph.upstreamByNode[id] ?? [];
    const inputs =
      upstreams.length === 0
        ? [{ from: null, output: 'ticket' }]
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
    branch: graph.branch,
  });
}

beforeEach(() => {
  completeMock.mockReset();
  staticCheckMock.mockReset();
  staticCheckMock.mockResolvedValue({ ok: true });
  completeMock.mockResolvedValue({
    text: "export async function run(input) { return { branch: 'billing' }; }\n",
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'mock',
  });
});

describe('router generation (existing per-node path)', () => {
  it('generates the ROUTER with a router purpose + a { branch:<key> } signal listing the VALID keys', async () => {
    const spec = routerSpec();
    const plan = routerPlan(spec);
    const router = plan.nodes.find((n) => n.id === 'route')!;

    await generateOneSystemNodeModule({
      node: router,
      spec,
      plan,
      governance: { user_id: 'u', project_id: 'p', ref: 'system.codegen' },
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    const userMessage = (completeMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    }).messages[0]!.content;

    // (a) router-specific framing.
    expect(userMessage).toContain('ROUTER node:');
    expect(userMessage).toContain('{ branch: <key>');
    // (b) the CLOSED set of valid keys the router must choose among.
    expect(userMessage).toContain("'billing'");
    expect(userMessage).toContain("'technical'");
  });

  it('a BRANCH node generates normally — NO router framing', async () => {
    const spec = routerSpec();
    const plan = routerPlan(spec);
    const branch = plan.nodes.find((n) => n.id === 'billing')!;

    await generateOneSystemNodeModule({
      node: branch,
      spec,
      plan,
      governance: { user_id: 'u', project_id: 'p', ref: 'system.codegen' },
    });

    const userMessage = (completeMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    }).messages[0]!.content;
    // The branch node's OWN purpose carries NO router framing. (The router's
    // purpose still appears in the project file-list section — expected +
    // correct, mirroring the judge / controller cases.)
    expect(userMessage).toContain("Purpose: Module for node 'billing'");
    expect(userMessage).not.toContain('Purpose: ROUTER node:');
  });
});
