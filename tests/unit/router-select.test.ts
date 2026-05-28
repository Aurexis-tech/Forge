// ROUTER SELECTION — the pure decision rule behind the router pattern.
// Proves: a decision selects EXACTLY ONE branch (its nodes execute, every
// other branch's nodes are skipped), and a decision matching NO key is a
// typed bad_input ('router_no_branch_match'), never a silent fall-through.
// The generated orchestrator inlines the equivalent logic; this is its
// testable embodiment (the analog of runBoundedLoop for loop_with_break).

import { describe, expect, it } from 'vitest';
import {
  selectRouterBranch,
  ROUTER_NO_BRANCH_MATCH,
} from '@/lib/engine/system/runtime/router-select';
import type { BranchMetadata } from '@/lib/engine/system/planner/graph';
import { EngineError } from '@/lib/engine/errors';

const META: BranchMetadata = {
  routerId: 'route',
  branches: [
    { key: 'alpha', nodeIds: ['a'] },
    { key: 'beta', nodeIds: ['b'] },
    { key: 'gamma', nodeIds: ['c'] },
  ],
};

describe('selectRouterBranch — selection', () => {
  it('decides A → ONLY A executes; B and C are skipped', () => {
    const sel = selectRouterBranch(META, 'alpha');
    expect(sel.selectedKey).toBe('alpha');
    expect(sel.executeNodeIds).toEqual(['a']);
    expect(sel.skipNodeIds.sort()).toEqual(['b', 'c']);
  });

  it('decides B → ONLY B executes; A and C are skipped', () => {
    const sel = selectRouterBranch(META, 'beta');
    expect(sel.executeNodeIds).toEqual(['b']);
    expect(sel.skipNodeIds.sort()).toEqual(['a', 'c']);
  });

  it('a multi-node branch executes all its nodes; other branches skip', () => {
    const meta: BranchMetadata = {
      routerId: 'route',
      branches: [
        { key: 'alpha', nodeIds: ['a', 'a2'] },
        { key: 'beta', nodeIds: ['b'] },
      ],
    };
    const sel = selectRouterBranch(meta, 'alpha');
    expect(sel.executeNodeIds).toEqual(['a', 'a2']);
    expect(sel.skipNodeIds).toEqual(['b']);
  });
});

describe('selectRouterBranch — no-match is typed bad_input', () => {
  function expectNoMatch(decision: unknown) {
    try {
      selectRouterBranch(META, decision);
      expect.fail('expected a router_no_branch_match EngineError');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe(ROUTER_NO_BRANCH_MATCH);
    }
  }

  it('an unknown branch key → bad_input (not a silent fall-through)', () => {
    expectNoMatch('delta');
  });

  it('a missing / non-string decision → bad_input', () => {
    expectNoMatch(undefined);
    expectNoMatch(null);
    expectNoMatch(42);
  });
});
