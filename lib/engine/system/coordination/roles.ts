// Special node-roles a coordination pattern can introduce beyond plain
// agent nodes. Leaf module (no imports) so every layer — the catalog,
// the pattern expanders, and the codegen per-node purpose — can share
// the SAME role predicates without an import cycle.

/** The role string that marks a node as the judge in competing_experts. */
export const JUDGE_ROLE = 'judge';

/** True when a node's role identifies it as a judge (case-insensitive). */
export function isJudgeRole(role: string): boolean {
  return role.trim().toLowerCase() === JUDGE_ROLE;
}

/** The role string that marks a node as the controller in loop_with_break. */
export const CONTROLLER_ROLE = 'controller';

/**
 * True when a node's role identifies it as the loop controller
 * (case-insensitive). The controller is the single node that, after the
 * body subgraph runs each iteration, decides whether to continue or break.
 */
export function isControllerRole(role: string): boolean {
  return role.trim().toLowerCase() === CONTROLLER_ROLE;
}

/** The role string that marks a node as the router in router (selection). */
export const ROUTER_ROLE = 'router';

/**
 * True when a node's role identifies it as the router (case-insensitive).
 * The router is the single node that reads the input and emits a structured
 * decision selecting EXACTLY ONE downstream branch to execute.
 */
export function isRouterRole(role: string): boolean {
  return role.trim().toLowerCase() === ROUTER_ROLE;
}
