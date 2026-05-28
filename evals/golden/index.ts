// The golden-case registry.
//
// One pinned (spec, plan) per LLM-driven mold. Infrastructure is
// intentionally absent — the IaC composer is deterministic, so there
// is no generation prompt to tune and no LLM output to score.
//
// Adding a case: define it in evals/golden/<kind>-<name>.ts and add
// the export here. The runner walks GOLDEN_CASES in order.

import { AGENT_GOLDEN } from './agent';
import { INFRASTRUCTURE_GOLDEN } from './infrastructure';
import { SOFTWARE_GOLDEN } from './software';
import { SYSTEM_GOLDEN } from './system';
import type { GoldenCase } from './types';

export const GOLDEN_CASES: readonly GoldenCase[] = [
  AGENT_GOLDEN,
  SYSTEM_GOLDEN,
  SOFTWARE_GOLDEN,
  INFRASTRUCTURE_GOLDEN,
];

export type { GoldenCase, GoldenCaseContract } from './types';
