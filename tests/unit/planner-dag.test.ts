// Unit test: Planner DAG validation (Kahn topological sort + cycle +
// duplicate-id detection). This is the cycle check the SYSTEM planner
// also reuses, so getting it right protects both Phase 1 and Phase 2.

import { describe, expect, it } from 'vitest';
import {
  validateTaskGraph,
  type PlanTask,
} from '@/lib/engine/planner/schema';

// Build a Kahn topological order from the validated tasks. Mirrors the
// algorithm inside validateTaskGraph; used here only to assert that a
// healthy DAG produces a deterministic order.
function topoOrder(tasks: ReadonlyArray<PlanTask>): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      const adjDep = adj.get(dep);
      if (adjDep) adjDep.push(t.id);
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const t of tasks) if ((indeg.get(t.id) ?? 0) === 0) queue.push(t.id);
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      const nd = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, nd);
      if (nd === 0) queue.push(next);
    }
  }
  return out;
}

const mkTask = (id: string, depends_on: string[] = []): PlanTask => ({
  id,
  title: id,
  description: id,
  depends_on,
});

describe('validateTaskGraph', () => {
  it('accepts a valid linear DAG', () => {
    const tasks = [
      mkTask('a'),
      mkTask('b', ['a']),
      mkTask('c', ['b']),
    ];
    expect(validateTaskGraph(tasks)).toEqual([]);
    expect(topoOrder(tasks)).toEqual(['a', 'b', 'c']);
  });

  it('accepts a diamond (fan-out then fan-in)', () => {
    const tasks = [
      mkTask('root'),
      mkTask('left', ['root']),
      mkTask('right', ['root']),
      mkTask('join', ['left', 'right']),
    ];
    expect(validateTaskGraph(tasks)).toEqual([]);
    // root must come first; join must come last; left/right can be in
    // either order between them.
    const order = topoOrder(tasks);
    expect(order[0]).toBe('root');
    expect(order[order.length - 1]).toBe('join');
    expect(order).toHaveLength(4);
    expect(new Set(order)).toEqual(new Set(['root', 'left', 'right', 'join']));
  });

  it('rejects a 2-node cycle', () => {
    const tasks = [
      mkTask('a', ['b']),
      mkTask('b', ['a']),
    ];
    const issues = validateTaskGraph(tasks);
    expect(issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('rejects a deeper cycle (3-node loop)', () => {
    const tasks = [
      mkTask('a', ['c']),
      mkTask('b', ['a']),
      mkTask('c', ['b']),
    ];
    const issues = validateTaskGraph(tasks);
    expect(issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('rejects a self-edge', () => {
    const tasks = [mkTask('a', ['a'])];
    const issues = validateTaskGraph(tasks);
    expect(issues.some((i) => i.kind === 'self_dep')).toBe(true);
  });

  it('rejects duplicate task ids', () => {
    const tasks = [
      mkTask('a'),
      mkTask('a'),
      mkTask('b', ['a']),
    ];
    const issues = validateTaskGraph(tasks);
    expect(issues.some((i) => i.kind === 'duplicate_id')).toBe(true);
  });

  it('rejects a dependency on an unknown task', () => {
    const tasks = [mkTask('a', ['ghost'])];
    const issues = validateTaskGraph(tasks);
    expect(issues.some((i) => i.kind === 'unknown_dep')).toBe(true);
  });

  it('topological order respects all dependencies', () => {
    const tasks = [
      mkTask('scaffold'),
      mkTask('handler', ['scaffold']),
      mkTask('schedule', ['handler']),
      mkTask('tests', ['handler']),
      mkTask('ship', ['schedule', 'tests']),
    ];
    expect(validateTaskGraph(tasks)).toEqual([]);
    const order = topoOrder(tasks);
    const pos = (id: string) => order.indexOf(id);
    expect(pos('scaffold')).toBeLessThan(pos('handler'));
    expect(pos('handler')).toBeLessThan(pos('schedule'));
    expect(pos('handler')).toBeLessThan(pos('tests'));
    expect(pos('schedule')).toBeLessThan(pos('ship'));
    expect(pos('tests')).toBeLessThan(pos('ship'));
  });
});
