// loop_with_break expand() — the deterministic graph layer.
//
// Hermetic, no LLM: the pattern produces an ACYCLIC body+controller DAG
// (so the existing generator/orchestrator/sandbox handle it unchanged)
// PLUS loop METADATA (the cyclic behaviour lives only in the runtime).
//   - catalog registration lists loop_with_break + its controller role
//   - expand() → body chain → controller, acyclic, with loop metadata
//   - constraints (typed bad_input): controller/body counts, max_iterations
//   - backward compat: standard graphs carry NO loop metadata

import { afterEach, describe, expect, it } from 'vitest';
import {
  ensurePatternsRegistered,
  expandCoordination,
  getPattern,
  isControllerRole,
  CONTROLLER_ROLE,
  listPatterns,
  _resetPatternsForTests,
} from '@/lib/engine/system/coordination';
import {
  SystemSpecSchema,
  ENGINE_LOOP_CEILING,
  type SystemSpec,
} from '@/lib/engine/system/spec';
import { EngineError } from '@/lib/engine/errors';

afterEach(() => {
  _resetPatternsForTests();
  ensurePatternsRegistered();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function loopSpec(opts: {
  body?: number;
  controllers?: number;
  maxIterations?: number;
  withLoop?: boolean;
} = {}): SystemSpec {
  const body = opts.body ?? 2;
  const controllers = opts.controllers ?? 1;
  const subAgents: SystemSpec['sub_agents'] = [];
  for (let i = 0; i < body; i++) {
    subAgents.push({
      id: 'body_' + i,
      role: 'Worker ' + i,
      description: 'does body work ' + i,
      inputs: ['task'],
      outputs: ['result_' + i],
    });
  }
  for (let j = 0; j < controllers; j++) {
    subAgents.push({
      id: 'controller' + (j === 0 ? '' : '_' + j),
      role: 'controller',
      description: 'decides continue vs break',
      inputs: ['result'],
      outputs: ['decision'],
    });
  }
  return SystemSpecSchema.parse({
    goal: 'Refine until good enough.',
    sub_agents: subAgents,
    coordination: { pattern: 'pipeline' },
    coordination_pattern: 'loop_with_break',
    ...(opts.withLoop === false
      ? {}
      : {
          loop: {
            max_iterations: opts.maxIterations ?? 3,
            break_condition: 'the result is good enough',
          },
        }),
    triggers: ['api'],
  });
}

// ===========================================================================
// CATALOG
// ===========================================================================
describe('coordination catalog — loop_with_break', () => {
  it('lists loop_with_break + declares the controller node role', () => {
    expect(listPatterns().map((p) => p.id)).toContain('loop_with_break');
    expect(getPattern('loop_with_break').node_roles).toEqual([CONTROLLER_ROLE]);
  });

  it('isControllerRole matches "controller" case-insensitively, nothing else', () => {
    expect(isControllerRole('controller')).toBe(true);
    expect(isControllerRole('  Controller ')).toBe(true);
    expect(isControllerRole('judge')).toBe(false);
    expect(isControllerRole('controllers')).toBe(false);
    expect(CONTROLLER_ROLE).toBe('controller');
  });
});

// ===========================================================================
// EXPAND — acyclic body+controller DAG + loop metadata
// ===========================================================================
describe('loop_with_break expand()', () => {
  it('chains the body in declaration order and hands off to the controller', () => {
    const graph = expandCoordination(loopSpec({ body: 3, maxIterations: 4 }));

    expect(graph.nodeIds).toEqual(['body_0', 'body_1', 'body_2', 'controller']);
    // body_0 → body_1 → body_2 → controller (acyclic).
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ['body_0', 'body_1'],
      ['body_1', 'body_2'],
      ['body_2', 'controller'],
    ]);
    expect(graph.executionOrder).toEqual([
      'body_0',
      'body_1',
      'body_2',
      'controller',
    ]);
    expect(graph.issues).toEqual([]);

    // No REAL back edge — controller→body / terminal→entry must NOT exist.
    for (const e of graph.edges) {
      expect(e.to).not.toBe('body_0');
    }
  });

  it('attaches loop metadata (controller, body order, cap, back edge)', () => {
    const graph = expandCoordination(loopSpec({ body: 2, maxIterations: 5 }));
    expect(graph.loop).toBeDefined();
    expect(graph.loop!.controllerId).toBe('controller');
    expect(graph.loop!.bodyNodeIds).toEqual(['body_0', 'body_1']);
    expect(graph.loop!.maxIterations).toBe(5);
    expect(graph.loop!.breakCondition).toBe('the result is good enough');
    // Back edge: terminal body output → body entry (metadata only).
    expect(graph.loop!.backEdge).toEqual({ from: 'body_1', to: 'body_0' });
  });

  it('a single body node wires body → controller; back edge is self-referential', () => {
    const graph = expandCoordination(loopSpec({ body: 1 }));
    expect(graph.nodeIds).toEqual(['body_0', 'controller']);
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ['body_0', 'controller'],
    ]);
    expect(graph.loop!.backEdge).toEqual({ from: 'body_0', to: 'body_0' });
  });
});

// ===========================================================================
// CONSTRAINTS — typed bad_input
// ===========================================================================
describe('loop_with_break constraints', () => {
  function expectBadInput(fn: () => unknown) {
    try {
      fn();
      expect.fail('expected a bad_input EngineError');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe('loop_with_break_constraint');
    }
  }

  it('0 controllers → bad_input (needs exactly 1)', () => {
    expectBadInput(() =>
      expandCoordination(loopSpec({ body: 2, controllers: 0 })),
    );
  });

  it('2 controllers → bad_input (needs exactly 1)', () => {
    expectBadInput(() =>
      expandCoordination(loopSpec({ body: 1, controllers: 2 })),
    );
  });

  it('0 body nodes → bad_input (needs >= 1; defensive past the spec min)', () => {
    // The spec schema requires >= 2 sub_agents, so a 0-body/1-controller
    // spec can't be parsed — bypass it to exercise the expand-time guard.
    const spec = {
      goal: 'x',
      sub_agents: [
        {
          id: 'controller',
          role: 'controller',
          description: 'decides',
          inputs: [],
          outputs: ['decision'],
        },
      ],
      coordination: { pattern: 'pipeline' },
      coordination_pattern: 'loop_with_break',
      loop: { max_iterations: 3, break_condition: 'stop' },
      triggers: ['api'],
      max_steps: 25,
    } as unknown as SystemSpec;
    expectBadInput(() => expandCoordination(spec));
  });

  it('missing loop block → bad_input', () => {
    expectBadInput(() => expandCoordination(loopSpec({ withLoop: false })));
  });

  it('max_iterations = 0 → bad_input', () => {
    expectBadInput(() => expandCoordination(loopSpec({ maxIterations: 0 })));
  });

  it('max_iterations > ENGINE_LOOP_CEILING → bad_input', () => {
    expectBadInput(() =>
      expandCoordination(loopSpec({ maxIterations: ENGINE_LOOP_CEILING + 1 })),
    );
  });

  it('max_iterations = ENGINE_LOOP_CEILING is allowed (boundary)', () => {
    const graph = expandCoordination(
      loopSpec({ maxIterations: ENGINE_LOOP_CEILING }),
    );
    expect(graph.loop!.maxIterations).toBe(ENGINE_LOOP_CEILING);
  });
});

// ===========================================================================
// BACKWARD COMPAT
// ===========================================================================
describe('loop metadata is additive', () => {
  it('a standard pipeline graph carries NO loop metadata', () => {
    const spec = SystemSpecSchema.parse({
      goal: 'Plain pipeline.',
      sub_agents: [
        { id: 'a', role: 'A', description: 'first', inputs: [], outputs: ['x'] },
        { id: 'b', role: 'B', description: 'second', inputs: ['x'], outputs: ['y'] },
      ],
      coordination: { pattern: 'pipeline' },
      triggers: ['api'],
    });
    expect(expandCoordination(spec).loop).toBeUndefined();
  });
});
