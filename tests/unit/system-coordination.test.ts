// Coordination-pattern catalog + competing_experts.
//
// Hermetic, no LLM: exercises the deterministic expand() layer.
//   - catalog registration validates + lists standard + competing_experts
//   - 'standard'.expand() === deriveGraph() (byte-identical delegation)
//   - backward compat: no coordination_pattern → 'standard'
//   - competing_experts → fan-out-to-judge acyclic DAG + constraints

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPETING_EXPERTS,
  STANDARD,
  ensurePatternsRegistered,
  expandCoordination,
  getPattern,
  isJudgeRole,
  JUDGE_ROLE,
  listPatterns,
  PatternRegistrationError,
  registerPattern,
  resolvePatternId,
  _resetPatternsForTests,
} from '@/lib/engine/system/coordination';
import { deriveGraph } from '@/lib/engine/system/planner/graph';
import { SystemSpecSchema, type SystemSpec } from '@/lib/engine/system/spec';
import { EngineError } from '@/lib/engine/errors';

afterEach(() => {
  _resetPatternsForTests();
  ensurePatternsRegistered();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function standardSpec(over: Partial<SystemSpec> = {}): SystemSpec {
  return SystemSpecSchema.parse({
    goal: 'Standard pipeline system.',
    sub_agents: [
      { id: 'a', role: 'A', description: 'first', inputs: [], outputs: ['x'] },
      { id: 'b', role: 'B', description: 'second', inputs: ['x'], outputs: ['y'] },
      { id: 'c', role: 'C', description: 'third', inputs: ['y'], outputs: ['z'] },
    ],
    coordination: { pattern: 'pipeline' },
    triggers: ['api'],
    ...over,
  });
}

function competingExpertsSpec(opts: {
  experts?: number;
  judges?: number;
} = {}): SystemSpec {
  const experts = opts.experts ?? 3;
  const judges = opts.judges ?? 1;
  const subAgents: SystemSpec['sub_agents'] = [];
  for (let i = 0; i < experts; i++) {
    subAgents.push({
      id: 'expert_' + i,
      role: 'Expert ' + i,
      description: 'expert candidate ' + i,
      inputs: ['task'],
      outputs: ['candidate_' + i],
    });
  }
  for (let j = 0; j < judges; j++) {
    subAgents.push({
      id: 'judge' + (j === 0 ? '' : '_' + j),
      role: 'judge',
      description: 'evaluates the candidates',
      inputs: ['candidates'],
      outputs: ['verdict'],
    });
  }
  return SystemSpecSchema.parse({
    goal: 'Competing experts system.',
    sub_agents: subAgents,
    coordination: { pattern: 'fan_out_in' },
    coordination_pattern: 'competing_experts',
    triggers: ['api'],
  });
}

// ===========================================================================
// CATALOG
// ===========================================================================
describe('coordination catalog', () => {
  it('lists standard + competing_experts (sorted)', () => {
    const ids = listPatterns().map((p) => p.id);
    expect(ids).toContain('standard');
    expect(ids).toContain('competing_experts');
  });

  it('getPattern returns the def; unknown id throws', () => {
    expect(getPattern('standard').id).toBe('standard');
    expect(getPattern('competing_experts').node_roles).toContain('judge');
    _resetPatternsForTests();
    // After a reset (before re-register) getPattern throws.
    expect(() => getPattern('standard')).toThrow(PatternRegistrationError);
  });

  it('registration rejects an unknown id', () => {
    _resetPatternsForTests();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerPattern({ ...STANDARD, id: 'freehand' as any }),
    ).toThrow(/closed PATTERN_IDS/);
  });

  it('registration rejects a duplicate id', () => {
    // standard is already registered by the auto-register on import.
    expect(() => registerPattern(STANDARD)).toThrow(/already registered/);
  });

  it('registration rejects a non-function expand', () => {
    _resetPatternsForTests();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerPattern({ ...STANDARD, expand: 'nope' as any }),
    ).toThrow(/expand must be a function/);
  });
});

// ===========================================================================
// STANDARD — byte-identical delegation
// ===========================================================================
describe("'standard' pattern delegates to deriveGraph", () => {
  it('expand() equals deriveGraph() for a sample spec', () => {
    const spec = standardSpec();
    expect(getPattern('standard').expand(spec)).toEqual(deriveGraph(spec));
  });

  it('expandCoordination of a spec WITHOUT coordination_pattern equals deriveGraph (backward-compat)', () => {
    const spec = standardSpec();
    expect(spec.coordination_pattern).toBeUndefined();
    expect(resolvePatternId(spec)).toBe('standard');
    expect(expandCoordination(spec)).toEqual(deriveGraph(spec));
  });

  it('an explicit coordination_pattern:standard also matches deriveGraph', () => {
    const spec = standardSpec({ coordination_pattern: 'standard' });
    expect(expandCoordination(spec)).toEqual(deriveGraph(spec));
  });
});

// ===========================================================================
// COMPETING_EXPERTS — fan-out-to-judge DAG
// ===========================================================================
describe('competing_experts expand()', () => {
  it('produces a fan-out-to-judge acyclic DAG', () => {
    const spec = competingExpertsSpec({ experts: 3, judges: 1 });
    const graph = expandCoordination(spec);

    // 3 experts + 1 judge = 4 nodes.
    expect(graph.nodeIds).toEqual(['expert_0', 'expert_1', 'expert_2', 'judge']);

    // Every edge is expert → judge.
    expect(graph.edges).toHaveLength(3);
    for (const e of graph.edges) {
      expect(e.to).toBe('judge');
      expect(e.from.startsWith('expert_')).toBe(true);
    }

    // The judge depends on ALL experts; experts have no upstream.
    expect(graph.upstreamByNode['judge']!.sort()).toEqual([
      'expert_0',
      'expert_1',
      'expert_2',
    ]);
    for (const id of ['expert_0', 'expert_1', 'expert_2']) {
      expect(graph.upstreamByNode[id]).toEqual([]);
    }

    // Acyclic: a topo order over all nodes with the judge LAST.
    expect(graph.executionOrder).toHaveLength(4);
    expect(graph.executionOrder[graph.executionOrder.length - 1]).toBe('judge');
    expect(graph.issues).toEqual([]);
  });

  it('edge payloads carry the expert candidate output', () => {
    const graph = expandCoordination(competingExpertsSpec({ experts: 2 }));
    const e0 = graph.edges.find((e) => e.from === 'expert_0')!;
    expect(e0.payload).toBe('candidate_0');
  });
});

// ===========================================================================
// CONSTRAINTS — typed bad_input
// ===========================================================================
describe('competing_experts constraints', () => {
  function expectBadInput(fn: () => unknown) {
    try {
      fn();
      expect.fail('expected a bad_input EngineError');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe('competing_experts_constraint');
    }
  }

  it('1 expert → bad_input (needs >= 2 experts)', () => {
    expectBadInput(() => expandCoordination(competingExpertsSpec({ experts: 1, judges: 1 })));
  });

  it('0 judges → bad_input (needs exactly 1 judge)', () => {
    expectBadInput(() => expandCoordination(competingExpertsSpec({ experts: 3, judges: 0 })));
  });

  it('2 judges → bad_input (needs exactly 1 judge)', () => {
    expectBadInput(() => expandCoordination(competingExpertsSpec({ experts: 2, judges: 2 })));
  });
});

// ===========================================================================
// ROLES
// ===========================================================================
describe('isJudgeRole', () => {
  it('matches "judge" case-insensitively, nothing else', () => {
    expect(isJudgeRole('judge')).toBe(true);
    expect(isJudgeRole('Judge')).toBe(true);
    expect(isJudgeRole('  JUDGE ')).toBe(true);
    expect(isJudgeRole('expert')).toBe(false);
    expect(isJudgeRole('judger')).toBe(false);
    expect(JUDGE_ROLE).toBe('judge');
  });

  it('COMPETING_EXPERTS declares the judge node role', () => {
    expect(COMPETING_EXPERTS.node_roles).toEqual(['judge']);
  });
});
