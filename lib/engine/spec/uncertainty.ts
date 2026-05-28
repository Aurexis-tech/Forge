// UNCERTAINTY DETECTOR — the gap between the SPEC_QUALITY_BAR and
// the spec the extractor produced.
//
// Pure function: (mold, spec, confidence, intent) -> UncertaintyReport.
// No LLM. Reuses the SPEC_QUALITY_BAR from quality.ts as the
// authoritative definition of "the bar."
//
// The detector scans the confidence map (from confidence.ts) and
// emits one UncertaintyEntry per field that:
//   - is 'missing' (the value is empty/null/unset)
//   - is 'guessed' (the engine picked a default the user didn't ask
//     for, on a field high enough on the leverage table)
//   - is 'inferred' AND the field is high-leverage enough to be
//     worth disambiguating (low-leverage 'inferred' entries are
//     left alone — the spec is good enough)
//
// Each entry carries a LEVERAGE SCORE: how much the rest of the
// pipeline relies on this field. The clarification loop asks about
// the HIGHEST-LEVERAGE entry; everything else is left for the user
// to refine at the show-spec gate.

import type { SpecMold } from './quality';
import type { ConfidenceLevel, SpecConfidence } from './confidence';

// ---------------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------------
export interface UncertaintyEntry {
  /** Field name in the confidence map (matches confidence.ts keys). */
  readonly field: string;
  /** The confidence label for this field. */
  readonly level: ConfidenceLevel;
  /**
   * Which SPEC_QUALITY_BAR criterion this entry maps onto. Used in
   * eval reports + the gate UI so the user sees WHY the field is
   * called out. Free-form string for now (the criterion ids are
   * stable but not narrowly typed here to avoid a circular import
   * with quality.ts).
   */
  readonly criterion: string;
  /**
   * 0..100. Higher = the rest of the pipeline (planner, codegen,
   * sandbox, runtime) leans more on this field, so the cost of
   * leaving it ambiguous is higher.
   */
  readonly leverage: number;
}

export interface UncertaintyReport {
  readonly mold: SpecMold;
  /** Sorted by leverage DESC. Stable tie-break by field name ASC. */
  readonly entries: ReadonlyArray<UncertaintyEntry>;
  /**
   * Convenience flag: does any entry exceed LEVERAGE_THRESHOLD?
   * The clarification loop short-circuits when this is false.
   */
  readonly hasActionable: boolean;
}

// ---------------------------------------------------------------------------
// Leverage table — per (mold, field). 0..100. Lookup miss = 0
// (unknown field — don't bother asking about it).
//
// Rationale comment per row says WHY the leverage is high/low —
// useful when adding new fields without re-deriving from scratch.
// ---------------------------------------------------------------------------
type LeverageTable = Record<SpecMold, Record<string, number>>;

const LEVERAGE_TABLE: LeverageTable = {
  agent: {
    // The whole pipeline hangs off these:
    goal: 90,           // codegen prompt anchors on the goal sentence
    capabilities: 90,   // planner grounds against the tool registry
    trigger: 85,        // wrong trigger = whole entrypoint regenerated
    inputs: 70,         // entrypoint signature
    outputs: 60,        // return-shape contract
    description: 40,
    runtime: 40,
    success_criteria: 30,
    constraints: 30,
    risk: 20,
    name: 10,           // cosmetic
  },
  system: {
    sub_agents: 100,            // no system without them
    coordination_pattern: 95,   // orchestrator dispatch shape
    goal: 80,
    triggers: 60,
    max_steps: 30,
  },
  software: {
    entities: 100,                  // migrations + every CRUD route hang off this
    pages: 90,                      // page count = task count
    auth_per_user_isolation: 90,    // RLS policy generation pivots on this
    auth_requires_auth: 80,
    flows: 60,                      // picks which routes to emit
    goal: 50,
  },
  infrastructure: {
    resources: 100,   // empty = no infra
    lifecycle: 95,    // destroy-policy
    topology: 80,     // provisioning order
    goal: 60,
    region: 40,
  },
};

/** The threshold at or above which the clarification loop will
 *  ASK about an uncertainty. Below this, the entry is recorded in
 *  the report but the loop short-circuits to the show-spec gate.
 *
 *  Engine-owned so evals + UI can reference one constant. */
export const LEVERAGE_THRESHOLD = 70;

/** Per-mold map from field → which SPEC_QUALITY_BAR criterion it
 *  most clearly relates to. Used to fill the `criterion` field on
 *  each entry. Names are free-form (no narrow type here to avoid a
 *  circular import). When a field doesn't map cleanly, we fall back
 *  to 'no_placeholder_values' which is the catch-all base criterion. */
type CriterionMap = Record<SpecMold, Record<string, string>>;

const FIELD_TO_CRITERION: CriterionMap = {
  agent: {
    name: 'no_placeholder_values',
    goal: 'actionable_goal',
    description: 'actionable_goal',
    trigger: 'agent_trigger_explicit',
    runtime: 'no_placeholder_values',
    inputs: 'agent_inputs_outputs_concrete',
    outputs: 'agent_inputs_outputs_concrete',
    capabilities: 'agent_tools_from_registry',
    constraints: 'edge_cases_captured',
    success_criteria: 'success_criteria_stated',
    risk: 'no_placeholder_values',
  },
  system: {
    goal: 'actionable_goal',
    sub_agents: 'system_sub_agent_role_and_handoff',
    coordination_pattern: 'system_coordination_pattern_declared',
    triggers: 'no_placeholder_values',
    max_steps: 'system_max_steps_explicit',
  },
  software: {
    goal: 'actionable_goal',
    pages: 'software_pages_and_entities_concrete',
    entities: 'software_pages_and_entities_concrete',
    flows: 'software_flows_named',
    auth_requires_auth: 'software_auth_model_explicit',
    auth_per_user_isolation: 'software_auth_model_explicit',
  },
  infrastructure: {
    goal: 'actionable_goal',
    resources: 'infra_resources_from_catalog',
    topology: 'infra_topology_explicit',
    lifecycle: 'infra_lifecycle_declared',
    region: 'infra_region_and_sizing_concrete',
  },
};

// ---------------------------------------------------------------------------
// Detector.
// ---------------------------------------------------------------------------
export interface DetectUncertaintyArgs {
  mold: SpecMold;
  /** The extracted spec (not used for content — only included so
   *  future heuristics can introspect specific values). */
  spec: unknown;
  /** Confidence map produced by lib/engine/spec/confidence.ts. */
  confidence: SpecConfidence;
  /** Original intent — kept for symmetry / future heuristics. */
  intent: string;
}

export function detectUncertainty(args: DetectUncertaintyArgs): UncertaintyReport {
  const { mold, confidence } = args;
  const leverages = LEVERAGE_TABLE[mold];
  const criteria = FIELD_TO_CRITERION[mold];
  const entries: UncertaintyEntry[] = [];

  for (const [field, level] of Object.entries(confidence)) {
    if (level === 'stated') continue; // Fully grounded — never ask.
    const leverage = leverages[field] ?? 0;
    // For 'inferred', only surface when leverage clears the
    // threshold; for 'guessed' and 'missing', always surface (the
    // user picks based on leverage at the gate). The detector is
    // permissive in what it RETURNS — the loop is the gatekeeper.
    if (level === 'inferred' && leverage < LEVERAGE_THRESHOLD) continue;
    const criterion = criteria[field] ?? 'no_placeholder_values';
    entries.push({ field, level, criterion, leverage });
  }

  entries.sort((a, b) => {
    if (a.leverage !== b.leverage) return b.leverage - a.leverage;
    // Stable tie-break: prefer 'missing' > 'guessed' > 'inferred',
    // then field name ASC.
    const levelRank: Record<ConfidenceLevel, number> = {
      missing: 0,
      guessed: 1,
      inferred: 2,
      stated: 3,
    };
    if (levelRank[a.level] !== levelRank[b.level]) {
      return levelRank[a.level] - levelRank[b.level];
    }
    return a.field.localeCompare(b.field);
  });

  const hasActionable = entries.some((e) => e.leverage >= LEVERAGE_THRESHOLD);
  return { mold, entries, hasActionable };
}

// ---------------------------------------------------------------------------
// Question SELECTOR — deterministic. Picks the highest-leverage
// uncertainty and returns it + a hand-authored question template
// for the (mold, field, level) tuple.
//
// The question text is HAND-AUTHORED here because we want every
// asked question to be specific and useful, not generic ("tell me
// more about X"). A small LLM call can later POLISH the wording
// (passed into the clarification loop as a `phraser` seam), but the
// selector itself is pure.
// ---------------------------------------------------------------------------
export interface SelectedClarification {
  readonly entry: UncertaintyEntry;
  readonly question: string;
}

export function selectClarification(
  report: UncertaintyReport,
): SelectedClarification | null {
  if (!report.hasActionable) return null;
  const top = report.entries.find((e) => e.leverage >= LEVERAGE_THRESHOLD);
  if (!top) return null;
  return { entry: top, question: questionFor(report.mold, top) };
}

function questionFor(mold: SpecMold, entry: UncertaintyEntry): string {
  const key = (entry.field + ':' + entry.level) as keyof typeof TEMPLATES_AGENT;
  const table =
    mold === 'agent'
      ? TEMPLATES_AGENT
      : mold === 'system'
        ? TEMPLATES_SYSTEM
        : mold === 'software'
          ? TEMPLATES_SOFTWARE
          : TEMPLATES_INFRA;
  const direct = (table as Record<string, string | undefined>)[key];
  if (direct) return direct;
  // Fallback: ask about the field generically. Last-resort phrasing
  // when a specific template isn't authored.
  return (
    'I had to ' +
    (entry.level === 'missing' ? 'leave out' : entry.level === 'guessed' ? 'pick a default for' : 'infer') +
    " the '" +
    entry.field +
    "' part of the spec. Could you tell me more about it?"
  );
}

// ---------------------------------------------------------------------------
// Hand-authored question templates per (mold, field:level). The
// detector picks WHICH field; this table picks the WORDS.
// ---------------------------------------------------------------------------
const TEMPLATES_AGENT = {
  'goal:missing':
    "I couldn't pin down the goal in one sentence. Can you describe what this agent does in one line — what does it produce, and how would you know it worked?",
  'trigger:missing':
    'When should this run? On a schedule (e.g. daily), when an external event happens (a webhook), when something calls an API, or as a chat conversation?',
  'trigger:guessed':
    'When should this run — every morning on a schedule, on demand when something happens, or as a chat? I picked one default but want to confirm.',
  'capabilities:missing':
    "What tools does this agent need? For example: web_search, http_request, llm_completion, file_read, file_write, schedule, email_read, email_send. Pick the ones it needs.",
  'capabilities:inferred':
    'I inferred a set of tools for this agent. Should it use any others (e.g. email_send, web_search, http_request)?',
  'inputs:missing':
    'What inputs does this agent take when it runs? (Name + brief description of each.)',
  'outputs:missing':
    'What does this agent produce when it succeeds? (Name + brief description of each output.)',
} as const;

const TEMPLATES_SYSTEM = {
  'sub_agents:missing':
    "A multi-agent system needs at least two sub-agents. What are the distinct roles? (e.g. \"scraper\", \"summarizer\", \"broadcaster\")",
  'sub_agents:inferred':
    'I inferred the sub-agents. Does each role make sense, and is anything missing or merged together that should be separate?',
  'coordination_pattern:missing':
    'How should these agents coordinate? Pipeline (one after another), fan-out/fan-in (one dispatches in parallel + aggregates), or DAG (arbitrary graph)?',
  'coordination_pattern:guessed':
    'I picked a pipeline by default. Should they actually run in parallel and combine results (fan-out/fan-in), or in some other graph (DAG)?',
  'triggers:missing':
    'When should the whole system run? On a schedule, on a webhook, on an API call, or via chat?',
} as const;

const TEMPLATES_SOFTWARE = {
  'entities:missing':
    "I couldn't pin down the data model. What information should each main thing in the app track? Name the key fields (e.g. for an expense: amount, currency, category, date, description).",
  'entities:inferred':
    'I inferred the data model. Does each entity capture the fields you actually need, or am I missing/inventing columns?',
  'pages:missing':
    'What screens should the app have? Name each one and what the user does on it (e.g. "List expenses", "Submit expense", "Expense detail").',
  'pages:inferred':
    'I inferred the screens. Are these the right ones, or is one missing or unnecessary?',
  'auth_per_user_isolation:missing':
    'Should each user only see their own data, or is the app shared across users? (Affects how the database is locked down.)',
  'auth_per_user_isolation:guessed':
    "I assumed each user only sees their own data. Is that right, or should the data be shared across all users?",
  'auth_requires_auth:missing':
    'Should users sign in to use the app, or is it public?',
  'flows:missing':
    'What user journeys does the app support? (e.g. "submit an expense", "approve someone else\'s", "view history".)',
} as const;

const TEMPLATES_INFRA = {
  'resources:missing':
    'What pieces of infrastructure do you need? (e.g. a Postgres database, an object store, a queue, a worker, a cron, an HTTP service.)',
  'resources:inferred':
    'I inferred the resources. Is each one correct, and is anything missing or unnecessary?',
  'lifecycle:missing':
    'Should this infrastructure be persistent (data survives across deploys) or ephemeral (recreated each time, e.g. a preview environment)?',
  'lifecycle:guessed':
    'I assumed persistent infrastructure (data survives). If this is a preview / sandbox / throwaway setup, say so and I\'ll switch it to ephemeral.',
  'topology:missing':
    'Which resources depend on or feed into which? (e.g. "worker reads from queue + writes to postgres", "cron triggers worker".)',
} as const;
