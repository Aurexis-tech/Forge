// COORDINATION-PATTERN CATALOG — the CLOSED, vetted set of system
// topologies. The system analog of the software slot catalog + the infra
// module catalog: the engine owns the topology shapes; the LLM never
// freehand-invents them (it only enriches the nodes a pattern produces).
//
// 'standard' is the baseline and DELEGATES to the existing deriveGraph,
// so the catalog is the single dispatch point with zero behavioural risk
// for existing systems. 'competing_experts' is the first real pattern.
//
// Future patterns (loop_with_break, router, hierarchical) register here.

import { DEFAULT_PATTERN_ID, PATTERN_IDS, type PatternId, type SystemSpec } from '../spec';
import type { DerivedGraph } from '../planner/graph';
import type { CoordinationPatternDef } from './types';
import { STANDARD } from './standard';
import { COMPETING_EXPERTS } from './competing-experts';

export class PatternRegistrationError extends Error {
  constructor(
    public readonly patternId: string,
    public readonly reason: string,
  ) {
    super(
      'coordination pattern registration failed for ' +
        JSON.stringify(patternId) +
        ': ' +
        reason,
    );
    this.name = 'PatternRegistrationError';
  }
}

const REGISTRY = new Map<PatternId, CoordinationPatternDef>();

export function registerPattern(def: CoordinationPatternDef): void {
  validatePattern(def);
  REGISTRY.set(def.id, def);
}

export function getPattern(id: PatternId): CoordinationPatternDef {
  const def = REGISTRY.get(id);
  if (!def) {
    throw new PatternRegistrationError(id, 'no pattern registered under this id');
  }
  return def;
}

export function listPatterns(): CoordinationPatternDef[] {
  // Deterministic order — sorted by id.
  return Array.from(REGISTRY.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function validatePattern(def: CoordinationPatternDef): void {
  if (!PATTERN_IDS.includes(def.id)) {
    throw new PatternRegistrationError(
      String(def.id),
      'id must be one of the closed PATTERN_IDS: ' + PATTERN_IDS.join(', '),
    );
  }
  if (REGISTRY.has(def.id)) {
    throw new PatternRegistrationError(def.id, 'a pattern with this id is already registered');
  }
  if (typeof def.label !== 'string' || def.label.trim().length === 0) {
    throw new PatternRegistrationError(def.id, 'label must be a non-empty string');
  }
  if (typeof def.description !== 'string' || def.description.trim().length === 0) {
    throw new PatternRegistrationError(def.id, 'description must be a non-empty string');
  }
  if (!Array.isArray(def.node_roles)) {
    throw new PatternRegistrationError(def.id, 'node_roles must be an array');
  }
  if (typeof def.expand !== 'function') {
    throw new PatternRegistrationError(def.id, 'expand must be a function');
  }
}

let registered = false;

/** Register the built-in patterns. Idempotent. */
export function ensurePatternsRegistered(): void {
  if (registered && REGISTRY.has('standard')) return;
  if (!REGISTRY.has(STANDARD.id)) registerPattern(STANDARD);
  if (!REGISTRY.has(COMPETING_EXPERTS.id)) registerPattern(COMPETING_EXPERTS);
  registered = true;
}

ensurePatternsRegistered();

/** Test-only: clear the registry so a fixture can register a clean set. */
export function _resetPatternsForTests(): void {
  REGISTRY.clear();
  registered = false;
}

/** Resolve a spec's pattern id, defaulting to 'standard'. */
export function resolvePatternId(spec: SystemSpec): PatternId {
  return spec.coordination_pattern ?? DEFAULT_PATTERN_ID;
}

/**
 * THE SINGLE DISPATCH POINT. Produce the orchestration graph for a spec
 * by routing through the catalog. planSystem calls this instead of
 * deriveGraph directly. For a 'standard' spec this IS deriveGraph
 * (byte-identical); other patterns expand their own topology.
 */
export function expandCoordination(spec: SystemSpec): DerivedGraph {
  ensurePatternsRegistered();
  return getPattern(resolvePatternId(spec)).expand(spec);
}

export type { CoordinationPatternDef } from './types';
export { JUDGE_ROLE, isJudgeRole } from './roles';
export { STANDARD } from './standard';
export { COMPETING_EXPERTS } from './competing-experts';
