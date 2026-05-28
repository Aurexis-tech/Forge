// ROUTER SELECTION — the pure decision rule behind the router pattern.
//
// Given the branch metadata + the router's emitted decision, this returns
// which nodes EXECUTE (the selected branch) and which are SKIPPED (every
// other branch). It is the testable embodiment of the selection contract;
// the generated orchestrator (a deterministic, templated string that runs
// in the sandbox) inlines the EQUIVALENT logic. Keeping the rule here —
// pure, no I/O — lets the hermetic tests prove selection + the no-match
// failure without executing sandbox code, exactly as runBoundedLoop does
// for loop_with_break.
//
// A decision matching NO branch key is a typed bad_input
// ('router_no_branch_match') — never a silent fall-through. The
// orchestrator mirrors this by throwing an OrchestratorError whose message
// carries the same marker.

import { badInputError } from '../../errors';
import type { BranchMetadata } from '../planner/graph';

export interface RouterSelection {
  /** The branch key the router selected. */
  readonly selectedKey: string;
  /** Node ids that EXECUTE (the selected branch, in order). */
  readonly executeNodeIds: string[];
  /** Node ids that are SKIPPED (every other branch's nodes). */
  readonly skipNodeIds: string[];
}

export const ROUTER_NO_BRANCH_MATCH = 'router_no_branch_match';

/**
 * Resolve the router's decision to a branch selection.
 *
 * @throws EngineError(bad_input, 'router_no_branch_match') when `decision`
 *   is missing / not a string / matches no branch key. Listing the valid
 *   keys in the message makes the failure actionable.
 */
export function selectRouterBranch(
  branch: BranchMetadata,
  decision: unknown,
): RouterSelection {
  const validKeys = branch.branches.map((b) => b.key);
  const selected =
    typeof decision === 'string'
      ? branch.branches.find((b) => b.key === decision)
      : undefined;

  if (!selected) {
    throw badInputError(
      ROUTER_NO_BRANCH_MATCH,
      'router decision ' +
        JSON.stringify(decision) +
        ' matched no branch key (valid keys: ' +
        validKeys.map((k) => JSON.stringify(k)).join(', ') +
        ')',
      'The router chose a branch that does not exist.',
    );
  }

  const executeSet = new Set(selected.nodeIds);
  const skipNodeIds: string[] = [];
  for (const b of branch.branches) {
    if (b.key === selected.key) continue;
    for (const id of b.nodeIds) {
      if (!executeSet.has(id)) skipNodeIds.push(id);
    }
  }

  return {
    selectedKey: selected.key,
    executeNodeIds: [...selected.nodeIds],
    skipNodeIds,
  };
}
