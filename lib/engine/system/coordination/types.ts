// The CLOSED coordination-pattern contract. A pattern is a vetted,
// engine-owned topology generator — the system analog of the software
// slot catalog + the infra module catalog. The LLM never freehand-
// invents topology; it only enriches the nodes a pattern's expand()
// produces (task + tools), exactly as today.

import type { DerivedGraph } from '../planner/graph';
import type { PatternId, SystemSpec } from '../spec';

export interface CoordinationPatternDef {
  /** Stable id from the closed PATTERN_IDS enum. */
  readonly id: PatternId;
  readonly label: string;
  readonly description: string;
  /**
   * Special node roles this pattern introduces beyond plain agent
   * nodes (e.g. competing_experts adds 'judge'). Empty for 'standard'.
   */
  readonly node_roles: readonly string[];
  /**
   * PURE. Produce the orchestration graph (nodes + edges + topo order)
   * that the existing planner + generator consume. For an acyclic
   * pattern the result passes validateTaskGraph by construction.
   * Throws a typed bad_input EngineError when the spec violates the
   * pattern's constraints (e.g. wrong expert/judge counts).
   */
  readonly expand: (spec: SystemSpec) => DerivedGraph;
}
