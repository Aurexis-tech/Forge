// Special node-roles a coordination pattern can introduce beyond plain
// agent nodes. Leaf module (no imports) so every layer — the catalog,
// the pattern expanders, and the codegen per-node purpose — can share
// the SAME judge-role predicate without an import cycle.

/** The role string that marks a node as the judge in competing_experts. */
export const JUDGE_ROLE = 'judge';

/** True when a node's role identifies it as a judge (case-insensitive). */
export function isJudgeRole(role: string): boolean {
  return role.trim().toLowerCase() === JUDGE_ROLE;
}
