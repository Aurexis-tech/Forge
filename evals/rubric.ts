// The QUALITY RUBRIC — what "good generated output" means.
//
// This is the explicit, written target. It is the TARGET the next
// generation-prompt iteration aims at, AND the instrument the eval
// harness scores against. Both tiers consume this file:
//
//   - Structural tier: checks the deterministic criteria below
//     (STRUCTURAL_CRITERIA) — pure pass/fail, no model judgment.
//
//   - Judged tier: shows the JUDGED_CRITERIA to a Haiku-tier
//     model and asks for a 1-5 score per criterion + a short note.
//     Gated on a model key; skipped + flagged when none is present.
//
// ALIGNMENT WITH THE ENGINE'S QUALITY_BAR
//
//   Each judged criterion carries a `qualityBarId` referencing
//   lib/engine/codegen/quality.ts — the engine's authoritative
//   definition of "good generated code." The generator is
//   INSTRUCTED against exactly the bar the rubric MEASURES.
//
//   Dependency direction: evals/ imports from the engine. The
//   engine never imports from evals/.
//
//   A module-load drift guard at the bottom of this file fails
//   loudly if a referenced qualityBarId has vanished from the
//   engine — so adding/removing a criterion in quality.ts can't
//   silently desynchronise the rubric.
//
// When the rubric changes, every prior report becomes incomparable.
// Add criteria additively (append, don't rewrite) and bump
// RUBRIC_VERSION so the report can record which target each run
// was scored against.

import {
  knownQualityBarIds,
  QUALITY_BAR_VERSION,
  type QualityBarId,
} from '@/lib/engine/codegen/quality';
import {
  knownSoftwareAddendumIds,
  SOFTWARE_ADDENDUM_VERSION,
  type SoftwareAddendumId,
} from '@/lib/engine/software/codegen/quality';
import {
  knownSpecBarIds,
  SPEC_QUALITY_BAR_VERSION,
  AGENT_SPEC_ADDENDUM_VERSION,
} from '@/lib/engine/spec/quality';
import {
  SYSTEM_SPEC_ADDENDUM_VERSION,
  SYSTEM_SPEC_ADDENDUM_IDS,
  type SystemSpecAddendumId,
} from '@/lib/engine/system/spec-quality';
import {
  SOFTWARE_SPEC_ADDENDUM_VERSION,
  SOFTWARE_SPEC_ADDENDUM_IDS,
  type SoftwareSpecAddendumId,
} from '@/lib/engine/software/spec-quality';
import {
  INFRA_SPEC_ADDENDUM_VERSION,
  INFRA_SPEC_ADDENDUM_IDS,
  type InfraSpecAddendumId,
} from '@/lib/engine/infra/spec-quality';

export const RUBRIC_VERSION = '1.0.0';
// Echo the engine bar versions into reports so a reader sees which
// bars each run was instructed + measured against. CODEGEN bars cover
// the generation tier; SPEC bars cover the spec-fidelity tier.
export {
  QUALITY_BAR_VERSION,
  SOFTWARE_ADDENDUM_VERSION,
  SPEC_QUALITY_BAR_VERSION,
  AGENT_SPEC_ADDENDUM_VERSION,
  SYSTEM_SPEC_ADDENDUM_VERSION,
  SOFTWARE_SPEC_ADDENDUM_VERSION,
  INFRA_SPEC_ADDENDUM_VERSION,
};
// Re-export addendum id types so eval surface code can reference
// engine ids without reaching directly into the engine.
export type {
  SoftwareAddendumId,
  SystemSpecAddendumId,
  SoftwareSpecAddendumId,
  InfraSpecAddendumId,
};

export interface RubricCriterion {
  /** Stable id used as a JSON key in reports. */
  id: string;
  /** Short human label for the report. */
  label: string;
  /** What "good" looks like — the prompt for the judged tier. */
  description: string;
}

// ---------------------------------------------------------------------------
// Structural criteria — checked deterministically by evals/structural.ts.
// No LLM, no judgment. Pure pass/fail per file or per case.
// ---------------------------------------------------------------------------
export const STRUCTURAL_CRITERIA: readonly RubricCriterion[] = [
  {
    id: 'static_check_passes',
    label: 'Static check passes',
    description:
      'Every generated file parses through esbuild.transform() without error. ' +
      'This is the same gate the codegen pipeline applies; a failure here ' +
      'means the LLM emitted code that does not even tokenise cleanly.',
  },
  {
    id: 'no_placeholders',
    label: 'No placeholder bodies',
    description:
      'Generated files contain no TODO / FIXME / XXX comments, no ' +
      '"not implemented" strings, no empty function bodies, and no ' +
      'placeholder returns like `return null; // placeholder`. The ' +
      'function body must DO the work, not promise to.',
  },
  {
    id: 'plan_files_materialised',
    label: 'Plan files materialised',
    description:
      'Every file the plan declared (and every file in the case\'s ' +
      'expectedFilePaths contract) is present in the output. Missing ' +
      'files mean a slot was silently skipped.',
  },
  {
    id: 'no_forbidden_imports',
    label: 'No forbidden imports',
    description:
      'No file imports a module matched by the case\'s ' +
      'forbiddenImportPatterns. This is where the server/client ' +
      'boundary and "no platform-internal imports" rules live.',
  },
  {
    id: 'required_content_present',
    label: 'Required content present',
    description:
      'Each path in requiredFileContents matches at least one of its ' +
      'mustMatchAny patterns. This catches output that looks plausible ' +
      'but missed the spec entirely (e.g. a "create expense" route that ' +
      'never mentions expenses).',
  },
];

// ---------------------------------------------------------------------------
// Judged criteria — shown to a Haiku-tier judge. Each scored 1-5 with
// a short note. Cheap; spend-gated; SKIPPED when no model key is set.
//
// Each entry carries a `qualityBarId` field pointing back at the
// engine's QUALITY_BAR. This is the structural link that keeps the
// generator's instructions and the harness's measurements aligned.
// The drift guard at the bottom of this file asserts every
// qualityBarId resolves to a real engine criterion.
// ---------------------------------------------------------------------------
export interface JudgedRubricCriterion extends RubricCriterion {
  /** Points back at lib/engine/codegen/quality.ts. */
  readonly qualityBarId: QualityBarId;
}

export const JUDGED_CRITERIA: readonly JudgedRubricCriterion[] = [
  {
    id: 'correctness',
    label: 'Correctness',
    qualityBarId: 'real_implementation',
    description:
      'Does the file actually do what the plan task described, or is ' +
      'the body a stub / vague approximation? 5 = the logic is concrete ' +
      'and matches the task; 1 = the body is a placeholder that does ' +
      'not implement the task at all.',
  },
  {
    id: 'spec_fidelity',
    label: 'Spec fidelity',
    qualityBarId: 'conforms_to_interface',
    description:
      'Does the file reflect the spec\'s actual nouns and constraints ' +
      '(real entity names, real flow names, the spec\'s success criteria), ' +
      'and conform to the exports/signatures the plan declared? ' +
      '5 = clearly written for THIS spec + exports match; 1 = generic boilerplate or wrong exports.',
  },
  {
    id: 'type_safety',
    label: 'Type safety',
    qualityBarId: 'idiomatic_typed',
    description:
      'Idiomatic TypeScript, narrow types, no unnecessary `any`, no ' +
      '`as unknown as`, no `@ts-ignore`. 5 = strict, narrow; 1 = `any` everywhere.',
  },
  {
    id: 'error_handling',
    label: 'Error handling',
    qualityBarId: 'validates_inputs_and_errors',
    description:
      'External calls (fetch, supabase, anthropic) and user input have ' +
      'explicit failure paths — typed errors, mapped HTTP statuses, no ' +
      'silent catches that swallow problems. 5 = errors propagate cleanly; ' +
      '1 = bare try/catch that returns 200 on every failure.',
  },
  {
    id: 'security_hygiene',
    label: 'Security hygiene',
    qualityBarId: 'no_insecure_patterns',
    description:
      'No secrets logged or echoed; no eval / Function / exec; no SQL ' +
      'string-concat (parameterised queries only); the server/client ' +
      'boundary is respected. 5 = clean across all of the above; ' +
      '1 = at least one obvious leak.',
  },
  {
    id: 'no_dead_code',
    label: 'No dead code',
    qualityBarId: 'no_dead_code',
    description:
      'No unused imports, no unused locals, no unreachable branches, no ' +
      'commented-out "alternative implementations." 5 = every line earns ' +
      'its place; 1 = visible dead code or large commented blocks.',
  },
];

// ---------------------------------------------------------------------------
// DRIFT GUARD — module-load assertion.
//
// Verifies two alignments at first import:
//
//   1. Every JUDGED_CRITERIA.qualityBarId still resolves to a real
//      entry in the engine's BASE QUALITY_BAR
//      (lib/engine/codegen/quality.ts).
//
//   2. The SOFTWARE ADDENDUM remains non-empty AND every advertised
//      addendum id still resolves. The software golden case is
//      scored against the addendum (structurally today via the
//      forbidden-import scanner; judged-tier coverage can land
//      additively without breaking older reports). This check
//      catches a regression where someone deletes an addendum
//      criterion without auditing eval references.
//
// If either alignment breaks, this throws LOUDLY at the first
// import — every eval-runner invocation, every machinery test,
// every typecheck of a downstream file.
//
// The reverse direction (engine criteria without a judged rubric
// entry) is allowed by design — some QUALITY_BAR items
// ('only_declared_imports') are covered by the structural tier and
// don't need a judged counterpart. We emit a console.warn for that
// case so the divergence is visible without being fatal.
// ---------------------------------------------------------------------------

// Software addendum ids the eval surface currently references. Today
// these are checked structurally (browser/service-role import
// scanner); listed here so a future judged criterion that points at
// an addendum id is structurally verified at module load too.
const REFERENCED_SOFTWARE_ADDENDUM_IDS: ReadonlyArray<SoftwareAddendumId> = [
  'data_access_server_client_only',
  'writes_pin_owner_id',
  'pages_server_components_by_default',
];

(function assertRubricAlignsWithEngine(): void {
  // 1. Base QUALITY_BAR drift.
  const engineIds = knownQualityBarIds();
  const referenced = new Set<QualityBarId>();
  for (const j of JUDGED_CRITERIA) {
    if (!engineIds.has(j.qualityBarId)) {
      throw new Error(
        '[evals/rubric] DRIFT: judged criterion "' +
          j.id +
          '" references qualityBarId "' +
          j.qualityBarId +
          '" which is no longer in lib/engine/codegen/quality.ts. ' +
          'Either restore the engine criterion or update this rubric ' +
          'to point at a current id.',
      );
    }
    referenced.add(j.qualityBarId);
  }
  // Non-fatal advisory the other direction.
  const unscored: string[] = [];
  for (const id of engineIds) {
    if (!referenced.has(id)) unscored.push(id);
  }
  if (unscored.length > 0 && process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.warn(
      '[evals/rubric] QUALITY_BAR ids without a judged counterpart (covered structurally or by design): ' +
        unscored.join(', '),
    );
  }

  // 2. Software (codegen) addendum drift.
  const addendumIds = knownSoftwareAddendumIds();
  for (const id of REFERENCED_SOFTWARE_ADDENDUM_IDS) {
    if (!addendumIds.has(id)) {
      throw new Error(
        '[evals/rubric] DRIFT: software addendum id "' +
          id +
          '" is referenced by the eval surface but no longer present in ' +
          'lib/engine/software/codegen/quality.ts. Restore the addendum ' +
          'criterion or update REFERENCED_SOFTWARE_ADDENDUM_IDS in rubric.ts.',
      );
    }
  }

  // 3. SPEC BAR drift — base bar + per-mold addenda referenced by
  //    the eval surface (evals/spec.ts judged tier scores against
  //    every advertised id, so every id must remain in the engine).
  //    The engine helper knownSpecBarIds() concatenates the base
  //    plus all four addenda; we walk the per-mold addendum id
  //    tuples directly to catch a single-mold regression.
  const specIds = knownSpecBarIds();
  const allAddendumIds: ReadonlyArray<{ src: string; ids: readonly string[] }> = [
    { src: 'system', ids: SYSTEM_SPEC_ADDENDUM_IDS },
    { src: 'software', ids: SOFTWARE_SPEC_ADDENDUM_IDS },
    { src: 'infrastructure', ids: INFRA_SPEC_ADDENDUM_IDS },
  ];
  for (const group of allAddendumIds) {
    for (const id of group.ids) {
      if (!specIds.has(id)) {
        throw new Error(
          '[evals/rubric] SPEC DRIFT: ' +
            group.src +
            ' spec addendum id "' +
            id +
            '" advertised by the engine module is missing from knownSpecBarIds(). ' +
            'lib/engine/spec/quality.ts likely lost a re-export.',
        );
      }
    }
  }
})();

// Convenience export for the runner: the union of criterion ids both
// tiers can score against. Used to build the report shape.
export const ALL_CRITERION_IDS = [
  ...STRUCTURAL_CRITERIA.map((c) => c.id),
  ...JUDGED_CRITERIA.map((c) => c.id),
] as const;
