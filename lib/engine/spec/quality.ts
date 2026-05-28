// The SPEC_QUALITY_BAR — the engine's authoritative definition of what
// "good extracted spec" means.
//
// THIS FILE IS THE SOURCE OF TRUTH for the BASE bar (criteria shared
// across every mold) AND the AGENT mold's addendum.
//
// Mirror of lib/engine/codegen/quality.ts exactly:
//   - versioned bar
//   - id / label / imperative / rationale per criterion
//   - per-mold addenda live in sibling files
//   - helpers (specQualityBarPromptBullets, knownSpecBarIds) so prompts
//     and evals reference one source of truth
//
// Two consumers:
//
//   1. The per-mold extractor prompt builders (lib/engine/spec/prompts.ts
//      + lib/engine/{system,software,infra}/prompts.ts) — each embeds
//      `specQualityBarPromptBullets(mold)` in its system prompt so the
//      model is INSTRUCTED against the exact bar the harness MEASURES.
//
//   2. The eval rubric drift guard (evals/rubric.ts) — validates that
//      any spec bar id referenced by the rubric or golden case still
//      resolves to a real entry in the engine. Module-load assertion;
//      fails loudly on drift.
//
// Dependency direction: ENGINE owns this. evals/ imports from here.
// NEVER the reverse.
//
// Versioning: bump SPEC_QUALITY_BAR_VERSION whenever a base criterion
// is added, removed, or semantically changes. Per-mold addenda have
// their own version constants so a mold-only revision doesn't force a
// bump on the others.

import { SYSTEM_SPEC_ADDENDUM } from '../system/spec-quality';
import { SOFTWARE_SPEC_ADDENDUM } from '../software/spec-quality';
import { INFRA_SPEC_ADDENDUM } from '../infra/spec-quality';

export const SPEC_QUALITY_BAR_VERSION = '1.0.0';
export const AGENT_SPEC_ADDENDUM_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// BASE BAR — applies to EVERY mold's extracted spec.
// ---------------------------------------------------------------------------
export const SPEC_QUALITY_BAR_IDS = [
  'actionable_goal',
  'concrete_examples',
  'named_resources_from_catalog',
  'edge_cases_captured',
  'success_criteria_stated',
  'no_placeholder_values',
] as const;
export type SpecQualityBarId = (typeof SPEC_QUALITY_BAR_IDS)[number];

export interface SpecQualityCriterion {
  /**
   * Stable id — referenced by the eval rubric. Typed as `string` so
   * per-mold addenda (lib/engine/{system,software,infra}/spec-quality.ts)
   * can use the same criterion shape with their own id sets. The
   * narrow per-set id types (SpecQualityBarId for the base set;
   * AgentSpecAddendumId etc. for addenda) live next to their
   * respective ID tuples and are used by helpers + drift guards.
   */
  readonly id: string;
  readonly label: string;
  readonly imperative: string;
  readonly rationale: string;
}

export const SPEC_QUALITY_BAR: readonly SpecQualityCriterion[] = [
  {
    id: 'actionable_goal',
    label: 'Goal is actionable and precise',
    imperative:
      "Write the goal as ONE sentence that names what the spec produces and how a person would tell it succeeded. Do NOT settle for a vague theme (\"help me with email\") — restate the user's intent as a concrete, observable outcome.",
    rationale:
      'A vague goal forces every downstream prompt to guess at intent. A precise goal is the single most leveraged sentence in the spec.',
  },
  {
    id: 'concrete_examples',
    label: 'Surface concrete examples the user implied',
    imperative:
      "When the user named specific examples (a URL, a sender, a category, a numeric threshold, a time-of-day), record them in the relevant field — don't paraphrase them into generic descriptions.",
    rationale:
      "Examples are the cheapest grounding signal. Losing them at intake costs precision in every downstream layer that can never get them back.",
  },
  {
    id: 'named_resources_from_catalog',
    label: 'Resources / tools / patterns are NAMED from the engine catalog',
    imperative:
      'For every place the schema accepts a catalog-backed value (tool id, coordination pattern, slot kind, resource type), pick from the catalog SLICE shown to you. Never invent ids. Never use free-text where an enum or registry entry exists.',
    rationale:
      "Free-text where the catalog applies makes the spec unprovable. The downstream planner can only reason about catalog-grounded specs; a free-text 'tool' wastes its grounding pass and stalls the build.",
  },
  {
    id: 'edge_cases_captured',
    label: 'Edge cases captured where the user implied them',
    imperative:
      "When the user mentioned a boundary (\"only paying users\", \"skip weekends\", \"if there are no results\"), capture it in `constraints` (agents/systems) or the appropriate field (flows for software, lifecycle/region for infra). Don't drop the boundary on the assumption it's obvious.",
    rationale:
      "Dropped boundaries become live-production surprises. The spec is the contract; if a boundary isn't written down, no later pass can enforce it.",
  },
  {
    id: 'success_criteria_stated',
    label: 'Success criteria stated where the schema asks for them',
    imperative:
      "Fill `success_criteria` (agents) — or the mold's equivalent — with observable signals (\"daily brief delivered before 9am\", \"row count after backfill matches source\"), not aspirational adjectives (\"reliable\", \"fast\"). Each criterion must be checkable by a human at runtime.",
    rationale:
      'Observable success criteria are the test surface for the eventual runtime. Without them the agent / system / app ships without anyone agreeing on what "working" means.',
  },
  {
    id: 'no_placeholder_values',
    label: 'No placeholder / vague fillers in required fields',
    imperative:
      "Required fields MUST carry real content. Never emit values like \"TBD\", \"various\", \"any\", \"to be determined\", \"placeholder\", or single-word fillers that don't answer the field's question. If you genuinely cannot decide, surface the gap via `open_questions` — do NOT paper over it with filler text.",
    rationale:
      'A "TBD" in a required field passes schema validation but is the same failure mode as an unfilled field. The user reviewing the spec gate cannot tell the two apart.',
  },
];

// ---------------------------------------------------------------------------
// AGENT ADDENDUM — applies to AgentSpec extraction only.
// ---------------------------------------------------------------------------
export const AGENT_SPEC_ADDENDUM_IDS = [
  'agent_tools_from_registry',
  'agent_inputs_outputs_concrete',
  'agent_trigger_explicit',
] as const;
export type AgentSpecAddendumId = (typeof AGENT_SPEC_ADDENDUM_IDS)[number];

export const AGENT_SPEC_ADDENDUM: readonly SpecQualityCriterion[] = [
  {
    id: 'agent_tools_from_registry' as SpecQualityBarId,
    label: 'Declared capability tools are drawn from the tool registry',
    imperative:
      "Every entry in `capabilities[].tool` MUST be a real registry id from the TOOL REGISTRY shown to you (e.g. web_search, http_request, llm_completion, file_read, file_write, schedule, email_read, email_send). Do not invent new tool ids; do not abbreviate them; do not capitalise them.",
    rationale:
      "The codegen scaffold only exposes registry-listed tools. Any other id will FAIL to resolve in the planner and stall the build — best to catch it at intake.",
  },
  {
    id: 'agent_inputs_outputs_concrete' as SpecQualityBarId,
    label: 'Inputs and outputs are concrete, not abstract',
    imperative:
      'Each `inputs[]` and `outputs[]` entry must carry a concrete shape — a named payload key + a description that says what the value looks like at runtime (e.g. "watch_url: a URL string the agent monitors"). Generic placeholders like "data" or "result" are insufficient.',
    rationale:
      'Concrete I/O lets the planner type the entrypoint signature. Abstract I/O forces the codegen layer to guess, and the LLM tends to guess "any".',
  },
  {
    id: 'agent_trigger_explicit' as SpecQualityBarId,
    label: 'Trigger is explicit and matches the user\'s language',
    imperative:
      'Pick `trigger` from the enum (chat / api / schedule / webhook). When the user mentions "every morning" / "daily" / "every Monday" pick `schedule`. When they mention "an endpoint" / "from another service" pick `api`. When they mention "when X happens" pick `webhook`. Otherwise `chat`. Do not default to `chat` when the prompt clearly implies a schedule.',
    rationale:
      'Trigger drives the scaffold (cron handler vs API handler vs webhook). A wrong trigger means a whole regenerated entrypoint, which is the most expensive thing to fix late.',
  },
];

// ---------------------------------------------------------------------------
// PROMPT-RENDERING HELPERS
// ---------------------------------------------------------------------------

export type SpecMold = 'agent' | 'system' | 'software' | 'infrastructure';

/**
 * Render the bar as a numbered list of imperative bullets for a
 * specific mold. The mold's extractor prompt calls this with its
 * discriminator; only base criteria + that mold's addendum criteria
 * appear in the rendered output. Single source of truth — the
 * prompts MUST NOT duplicate the imperative text inline.
 */
export function specQualityBarPromptBullets(mold: SpecMold): string {
  const addendum = pickAddendum(mold);
  const all: readonly SpecQualityCriterion[] = [
    ...SPEC_QUALITY_BAR,
    ...addendum,
  ];
  return all
    .map(
      (c, i) =>
        '  ' +
        String(i + 1).padStart(2, ' ') +
        '. ' +
        c.label +
        ' — ' +
        c.imperative +
        ' (' +
        c.rationale +
        ')',
    )
    .join('\n');
}

/** Return the version string a prompt should advertise for the given mold. */
export function specQualityBarVersionLabel(mold: SpecMold): string {
  const addendumVersion = ADDENDUM_VERSION[mold];
  return (
    'base v' + SPEC_QUALITY_BAR_VERSION + ' + ' + mold + ' addendum v' + addendumVersion
  );
}

/** All base + every-mold ids currently advertised. Used by the eval drift guard. */
export function knownSpecBarIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const c of SPEC_QUALITY_BAR) ids.add(c.id);
  for (const c of AGENT_SPEC_ADDENDUM) ids.add(c.id);
  for (const c of SYSTEM_SPEC_ADDENDUM) ids.add(c.id);
  for (const c of SOFTWARE_SPEC_ADDENDUM) ids.add(c.id);
  for (const c of INFRA_SPEC_ADDENDUM) ids.add(c.id);
  return ids;
}

function pickAddendum(mold: SpecMold): readonly SpecQualityCriterion[] {
  switch (mold) {
    case 'agent':
      return AGENT_SPEC_ADDENDUM;
    case 'system':
      return SYSTEM_SPEC_ADDENDUM;
    case 'software':
      return SOFTWARE_SPEC_ADDENDUM;
    case 'infrastructure':
      return INFRA_SPEC_ADDENDUM;
  }
}

import { SYSTEM_SPEC_ADDENDUM_VERSION } from '../system/spec-quality';
import { SOFTWARE_SPEC_ADDENDUM_VERSION } from '../software/spec-quality';
import { INFRA_SPEC_ADDENDUM_VERSION } from '../infra/spec-quality';

const ADDENDUM_VERSION: Record<SpecMold, string> = {
  agent: AGENT_SPEC_ADDENDUM_VERSION,
  system: SYSTEM_SPEC_ADDENDUM_VERSION,
  software: SOFTWARE_SPEC_ADDENDUM_VERSION,
  infrastructure: INFRA_SPEC_ADDENDUM_VERSION,
};
