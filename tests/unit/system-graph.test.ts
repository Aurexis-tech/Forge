// Unit test: System OrchestrationPlan graph derivation + cycle reuse
// + over-budget rejection (Phase 2 planner core).
//
// These tests cover the deterministic, no-LLM half of the system
// planner — the part that produces the topology from the spec and
// enforces structural invariants. The LLM detail pass (per-node task
// + tools) is exercised separately in the dry-run.

import { describe, expect, it } from 'vitest';
import {
  assertWithinStepBudget,
  deriveGraph,
  SystemGraphError,
  SystemPlanBudgetError,
} from '@/lib/engine/system/planner/graph';
import { SystemSpecSchema, type SystemSpec } from '@/lib/engine/system/spec';

function makeSpec(overrides: Partial<SystemSpec>): SystemSpec {
  const base = SystemSpecSchema.parse({
    goal: 'Test system.',
    sub_agents: [
      {
        id: 'a',
        role: 'A',
        description: 'first',
        inputs: [],
        outputs: ['x'],
      },
      {
        id: 'b',
        role: 'B',
        description: 'second',
        inputs: ['x'],
        outputs: ['y'],
      },
      {
        id: 'c',
        role: 'C',
        description: 'third',
        inputs: ['y'],
        outputs: ['z'],
      },
    ],
    coordination: { pattern: 'pipeline' },
    triggers: ['schedule'],
  });
  // Apply overrides on top of the validated base.
  return { ...base, ...overrides } as SystemSpec;
}

describe('deriveGraph', () => {
  describe('pattern=pipeline', () => {
    it('synthesises consecutive edges in declared order when none provided', () => {
      const spec = makeSpec({});
      const g = deriveGraph(spec);
      expect(g.nodeIds).toEqual(['a', 'b', 'c']);
      expect(g.edges.map((e) => [e.from, e.to])).toEqual([
        ['a', 'b'],
        ['b', 'c'],
      ]);
      expect(g.executionOrder).toEqual(['a', 'b', 'c']);
      expect(g.upstreamByNode).toEqual({ a: [], b: ['a'], c: ['b'] });
    });

    it('honours explicit edges if the spec supplied them', () => {
      const spec = makeSpec({
        coordination: {
          pattern: 'pipeline',
          edges: [
            { from: 'a', to: 'c' },
            { from: 'c', to: 'b' },
          ],
        },
      });
      const g = deriveGraph(spec);
      expect(g.edges.map((e) => [e.from, e.to])).toEqual([
        ['a', 'c'],
        ['c', 'b'],
      ]);
      // Topological order respects the explicit edges, not declaration order.
      const order = g.executionOrder;
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
      expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'));
    });
  });

  describe('pattern=fan_out_in', () => {
    it('synthesises head → workers → tail when no edges provided', () => {
      // 4 nodes: head + 2 workers + tail
      const spec = SystemSpecSchema.parse({
        goal: 'fan out demo',
        sub_agents: [
          { id: 'coordinator', role: 'c', description: 'fan-out', inputs: [], outputs: ['task'] },
          { id: 'worker_a', role: 'w', description: 'A', inputs: ['task'], outputs: ['result_a'] },
          { id: 'worker_b', role: 'w', description: 'B', inputs: ['task'], outputs: ['result_b'] },
          { id: 'aggregator', role: 'a', description: 'fan-in', inputs: ['result_a', 'result_b'], outputs: ['final'] },
        ],
        coordination: { pattern: 'fan_out_in' },
        triggers: ['chat'],
      });
      const g = deriveGraph(spec);
      // Coordinator → both workers; both workers → aggregator.
      const edgePairs = g.edges.map((e) => e.from + '->' + e.to).sort();
      expect(edgePairs).toEqual([
        'coordinator->worker_a',
        'coordinator->worker_b',
        'worker_a->aggregator',
        'worker_b->aggregator',
      ]);
      // Topological order: coordinator first, aggregator last.
      expect(g.executionOrder[0]).toBe('coordinator');
      expect(g.executionOrder[g.executionOrder.length - 1]).toBe('aggregator');
    });
  });

  describe('pattern=dag', () => {
    it('adopts the explicit edges verbatim', () => {
      // SystemSpecSchema requires edges for 'dag' — supply them.
      const spec = SystemSpecSchema.parse({
        goal: 'dag demo',
        sub_agents: [
          { id: 'root', role: 'root', description: 'r', inputs: [], outputs: ['x'] },
          { id: 'branch_a', role: 'a', description: 'a', inputs: ['x'], outputs: ['ya'] },
          { id: 'branch_b', role: 'b', description: 'b', inputs: ['x'], outputs: ['yb'] },
          { id: 'leaf', role: 'l', description: 'l', inputs: ['ya', 'yb'], outputs: ['z'] },
        ],
        coordination: {
          pattern: 'dag',
          edges: [
            { from: 'root', to: 'branch_a' },
            { from: 'root', to: 'branch_b' },
            { from: 'branch_a', to: 'leaf' },
            { from: 'branch_b', to: 'leaf' },
          ],
        },
        triggers: ['chat'],
      });
      const g = deriveGraph(spec);
      expect(g.edges.map((e) => [e.from, e.to]).sort()).toEqual(
        [
          ['root', 'branch_a'],
          ['root', 'branch_b'],
          ['branch_a', 'leaf'],
          ['branch_b', 'leaf'],
        ].sort(),
      );
      expect(g.executionOrder[0]).toBe('root');
      expect(g.executionOrder[g.executionOrder.length - 1]).toBe('leaf');
    });
  });

  describe('cycle rejection (reuses Phase 1 validateTaskGraph)', () => {
    it('throws SystemGraphError with a clear message on a cyclic dag', () => {
      // Construct a spec whose explicit edges form a cycle. The
      // SystemSpec validator doesn't catch graph cycles on its own —
      // that's the system-planner's job, via the reused Phase 1 check.
      // We pre-validate the spec then patch the edges past the
      // schema so we can exercise the planner's cycle detection.
      const valid = SystemSpecSchema.parse({
        goal: 'cycle demo',
        sub_agents: [
          { id: 'a', role: 'A', description: 'a', inputs: [], outputs: ['x'] },
          { id: 'b', role: 'B', description: 'b', inputs: ['x'], outputs: ['y'] },
          { id: 'c', role: 'C', description: 'c', inputs: ['y'], outputs: ['z'] },
        ],
        coordination: {
          pattern: 'dag',
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'c', to: 'a' }, // cycle
          ],
        },
        triggers: ['chat'],
      });
      expect(() => deriveGraph(valid)).toThrowError(SystemGraphError);
      try {
        deriveGraph(valid);
      } catch (e) {
        expect(e).toBeInstanceOf(SystemGraphError);
        const err = e as SystemGraphError;
        // Clear, human-readable message (no stack-style crash leak).
        expect(err.message).toMatch(/orchestration graph rejected/i);
        expect(err.message).toMatch(/cycle/i);
        // Issues array preserved so the caller can audit details.
        expect(err.issues.some((i) => i.kind === 'cycle')).toBe(true);
      }
    });
  });
});

describe('assertWithinStepBudget', () => {
  it('passes when node count is at or under the cap', () => {
    const spec = makeSpec({});
    const g = deriveGraph(spec);
    expect(() => assertWithinStepBudget(g, 3)).not.toThrow();
    expect(() => assertWithinStepBudget(g, 25)).not.toThrow();
  });

  it('throws SystemPlanBudgetError with a clear message when over the cap', () => {
    const spec = makeSpec({});
    const g = deriveGraph(spec);
    expect(() => assertWithinStepBudget(g, 2)).toThrowError(
      SystemPlanBudgetError,
    );
    try {
      assertWithinStepBudget(g, 2);
    } catch (e) {
      expect(e).toBeInstanceOf(SystemPlanBudgetError);
      const err = e as SystemPlanBudgetError;
      expect(err.nodes).toBe(3);
      expect(err.cap).toBe(2);
      // Message is a clean sentence, NOT a stack-trace leak.
      expect(err.message).toMatch(/3 nodes/);
      expect(err.message).toMatch(/max_steps at 2/);
    }
  });
});
