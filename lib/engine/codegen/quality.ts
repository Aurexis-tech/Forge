// The QUALITY_BAR — the engine's authoritative definition of what
// "good generated code" means for a single per-file LLM call.
//
// THIS FILE IS THE SOURCE OF TRUTH.
//
// Two consumers read this:
//
//   1. The codegen prompt builder (lib/engine/codegen/prompts.ts) —
//      embeds every criterion's `imperative` in the system prompt so
//      the model is INSTRUCTED against the exact bar the harness
//      MEASURES against.
//
//   2. The eval rubric (evals/rubric.ts) — its judged criteria
//      reference QUALITY_BAR entries by id via `qualityBarId`. A
//      module-load drift guard in evals/rubric.ts fails loudly if a
//      referenced id vanishes from this file.
//
// Dependency direction: ENGINE owns this. evals/ imports from here.
// NEVER the reverse. evals/ is a measurement instrument and must
// never end up in the engine's import graph.
//
// Versioning: bump QUALITY_BAR_VERSION whenever a criterion is added,
// removed, or its imperative semantically changes. The eval report
// records this version so before/after baselines are comparable.

export const QUALITY_BAR_VERSION = '1.0.0';

// The closed set of criterion ids. Used as a discriminator everywhere
// upstream consumers need to reference one entry by name. Adding a
// new criterion: extend this tuple AND the QUALITY_BAR array below.
// (TypeScript prevents the two from drifting because QUALITY_BAR is
// typed against QualityBarId.)
export const QUALITY_BAR_IDS = [
  'real_implementation',
  'validates_inputs_and_errors',
  'conforms_to_interface',
  'only_declared_imports',
  'idiomatic_typed',
  'no_dead_code',
  'no_insecure_patterns',
] as const;
export type QualityBarId = (typeof QUALITY_BAR_IDS)[number];

export interface QualityCriterion {
  /** Stable id — referenced by the eval rubric. */
  readonly id: QualityBarId;
  /** Short human label. Shown in reports and tool tips. */
  readonly label: string;
  /**
   * The imperative sentence the prompt renders verbatim — second
   * person, action-first, no hedging. The LLM reads this directly.
   */
  readonly imperative: string;
  /**
   * Why it matters. Surfaced in the prompt as the bullet's tail so
   * the model knows the WHY behind the rule, and surfaced in eval
   * reports so a reader six months from now understands the bar.
   */
  readonly rationale: string;
}

export const QUALITY_BAR: readonly QualityCriterion[] = [
  {
    id: 'real_implementation',
    label: 'Real implementation',
    imperative:
      'Implement the work in this file. Never emit TODO / FIXME / "not implemented" markers, empty function bodies, or placeholder returns that pretend the body will be filled later.',
    rationale:
      "The codegen pipeline ships this file. A stub here becomes a bug in production.",
  },
  {
    id: 'validates_inputs_and_errors',
    label: 'Validates inputs + handles errors',
    imperative:
      'Validate inputs at trust boundaries (function args, parsed payloads, env reads). When an external call can fail (tool invocation, fetch, parsing), surface the failure with a typed error or a clear thrown Error — never swallow it silently.',
    rationale:
      'Silent catches and unvalidated inputs are the most common LLM-codegen failure modes; we instruct against them explicitly so the model defaults to surfacing problems.',
  },
  {
    id: 'conforms_to_interface',
    label: 'Conforms to declared interface / exports',
    imperative:
      'Match exactly the exports, function signatures, and return shapes declared in the SCAFFOLD INTERFACE and described in the file purpose. If the role-in-plan says you export `run(input)` returning a typed object, do exactly that — no extra defaults, no renamed exports.',
    rationale:
      'The orchestrator and downstream files import these symbols by name. A drifted export breaks the build at link time.',
  },
  {
    id: 'only_declared_imports',
    label: 'Uses only declared tools + allowed imports',
    imperative:
      'Use ONLY the tools and modules surfaced in the SCAFFOLD INTERFACE and the TOOLS section. Never reimplement search / HTTP / LLM / file I/O / scheduling / email. Never invent tool ids. Never import from packages not present in the scaffolded package.json.',
    rationale:
      'Reimplemented tools bypass governance, ledgering, and the scaffold\'s safety boundaries. The registry IS the surface.',
  },
  {
    id: 'idiomatic_typed',
    label: 'Idiomatic + fully typed',
    imperative:
      'Write idiomatic TypeScript: narrow types, no unnecessary `any`, no `@ts-ignore`, no `as unknown as`. Prefer readonly where appropriate; prefer pure functions; keep side effects in tool calls.',
    rationale:
      'Strict mode is on. Loose types defeat the static-check signal and hide real bugs from the next layer.',
  },
  {
    id: 'no_dead_code',
    label: 'No dead code',
    imperative:
      'Do not emit unused imports, unused variables, unreachable branches, or commented-out alternative implementations. Every line in the file must contribute to the file\'s declared purpose.',
    rationale:
      'Dead code signals an unsure LLM and hides intent; it also bloats the file the user has to read and trust.',
  },
  {
    id: 'no_insecure_patterns',
    label: 'No obviously insecure patterns',
    imperative:
      'Do not log secrets or full request/response bodies of authenticated calls. Do not use eval / new Function / exec. Do not concatenate user input directly into shell commands, SQL strings, or URLs. Configuration comes from process.env — never hardcode keys, tokens, or sender addresses.',
    rationale:
      'These are the patterns that most often turn a working generated module into a security incident.',
  },
];

// Render the QUALITY_BAR as a numbered list of imperative bullets for
// the system prompt. Single source of truth — never duplicate the
// text in prompts.ts. The trailing rationale is included so the model
// has the WHY, which empirically reduces "follow the letter but miss
// the spirit" outputs.
export function qualityBarPromptBullets(): string {
  return QUALITY_BAR
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

// A compact, single-line summary for short logs / audit detail.
// Format: "v1.0.0: real_implementation, validates_inputs_and_errors, …".
export function qualityBarSummary(): string {
  return (
    'v' + QUALITY_BAR_VERSION + ': ' + QUALITY_BAR.map((c) => c.id).join(', ')
  );
}

// Helper for evals' drift guard — returns the set of ids the engine
// currently advertises, so the rubric can assert its referenced ids
// still exist.
export function knownQualityBarIds(): ReadonlySet<QualityBarId> {
  return new Set(QUALITY_BAR.map((c) => c.id));
}
