// Eval runner.
//
// Drives each golden case through TWO tiers:
//
//   1. SPEC-FIDELITY — runs the REAL per-mold extractor against the
//      case's intent; scores the produced spec against the engine's
//      SPEC_QUALITY_BAR (structural + key-gated judged).
//
//   2. GENERATION — for cases with a `plan` (every kind except
//      infrastructure), runs the REAL generator against the case's
//      pinned (spec, plan); scores the produced files against the
//      engine's QUALITY_BAR (structural + key-gated judged).
//
// HARD INVARIANTS
//   - Both pipelines flow through the REAL engine seams. No
//     reimplementation. Cost is metered via the existing complete()
//     → ledger seam.
//   - When extraction OR generation throws NeedsKeyError, that tier
//     is marked SKIPPED. The runner does not invent placeholder
//     specs / files to score against — that would be lying.
//   - The runner does NOT write the report to disk. The CLI entry
//     (evals/index.ts) does that, so this module is pure and easy
//     to test.

import { generateCode } from '@/lib/engine/codegen/generate';
import { generateSystemCode } from '@/lib/engine/system/codegen/generate';
import { generateSoftwareCode } from '@/lib/engine/software/codegen/generate';
import { extractSpec } from '@/lib/engine/spec/extract';
import { extractSystemSpec } from '@/lib/engine/system/extract';
import { extractSoftwareSpec } from '@/lib/engine/software/extract';
import { extractInfraSpec } from '@/lib/engine/infra/extract';
import { NeedsKeyError } from '@/lib/engine/keys';
import { GovernanceError } from '@/lib/engine/governance/guard';
import type { GovernanceScope } from '@/lib/engine/llm';
import {
  SPEC_QUALITY_BAR_VERSION,
  type SpecMold,
} from '@/lib/engine/spec/quality';
import { GOLDEN_CASES, type GoldenCase } from './golden';
import { JUDGED_CRITERIA, RUBRIC_VERSION, STRUCTURAL_CRITERIA } from './rubric';
import {
  scoreStructural,
  type StructuralReport,
  type UnifiedGenFile,
} from './structural';
import { scoreJudged, type JudgedReport } from './judge';
import {
  collectMoldIds,
  scoreSpecJudged,
  scoreSpecStructural,
  type SpecJudgedReport,
  type SpecStructuralReport,
} from './spec';

// ---------------------------------------------------------------------------
// Pluggable generator seam — for the hermetic machinery test to stub.
// ---------------------------------------------------------------------------
export interface Generators {
  agent: typeof generateCode;
  system: typeof generateSystemCode;
  software: typeof generateSoftwareCode;
}

export const REAL_GENERATORS: Generators = {
  agent: generateCode,
  system: generateSystemCode,
  software: generateSoftwareCode,
};

// ---------------------------------------------------------------------------
// Pluggable EXTRACTOR seam — parallel to Generators. The hermetic
// machinery test passes stubs that return canned ExtractionResults;
// production runs use the real ones.
// ---------------------------------------------------------------------------
export interface Extractors {
  agent: typeof extractSpec;
  system: typeof extractSystemSpec;
  software: typeof extractSoftwareSpec;
  infrastructure: typeof extractInfraSpec;
}

export const REAL_EXTRACTORS: Extractors = {
  agent: extractSpec,
  system: extractSystemSpec,
  software: extractSoftwareSpec,
  infrastructure: extractInfraSpec,
};

// ---------------------------------------------------------------------------
// Report shapes.
// ---------------------------------------------------------------------------
export interface ExtractionReport {
  status: 'completed' | 'skipped' | 'failed';
  reason?: string;
  durationMs: number;
  attempts?: number;
  model?: string;
}

export interface SpecFidelityReport {
  extraction: ExtractionReport;
  structural: SpecStructuralReport | { status: 'skipped'; reason: string };
  judged: SpecJudgedReport;
}

export interface GenerationReport {
  status: 'completed' | 'skipped' | 'failed';
  reason?: string;
  durationMs: number;
  fileCount: number;
  llmFilesGenerated?: number;
  attempts?: number;
  modelsUsed?: string[];
  warnings?: string[];
}

export interface CaseReport {
  case: {
    id: string;
    kind: GoldenCase['kind'];
    description: string;
  };
  specFidelity: SpecFidelityReport;
  generation: GenerationReport;
  structural: StructuralReport | { status: 'skipped'; reason: string };
  judged: JudgedReport;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  rubricVersion: string;
  specBarVersion: string;
  rubric: {
    structural: Array<{ id: string; label: string; description: string }>;
    judged: Array<{ id: string; label: string; description: string }>;
  };
  meta: {
    generationMode: 'real' | 'stubbed';
    extractionMode: 'real' | 'stubbed';
    judgeEnabled: boolean;
    specJudgeEnabled: boolean;
    judgeModel: string | null;
    requireByok: boolean;
  };
  cases: CaseReport[];
  aggregate: {
    cases: number;
    // Generation tier (filterable by cases that had a plan).
    structuralPassRate: number;
    judgedCriterionAverages: Record<string, number>;
    judgedCasesScored: number;
    // Spec-fidelity tier (covers ALL cases including infra).
    specStructuralPassRate: number;
    specJudgedCasesScored: number;
  };
}

// ---------------------------------------------------------------------------
// Runner options.
// ---------------------------------------------------------------------------
export interface RunOptions {
  /** Generation judged tier opt-in. */
  judge: boolean;
  /** Spec-fidelity judged tier opt-in. Independent of `judge`. */
  specJudge?: boolean;
  generators?: Generators;
  extractors?: Extractors;
  generationMode?: 'real' | 'stubbed';
  extractionMode?: 'real' | 'stubbed';
  onlyCaseIds?: readonly string[];
  runId?: string;
  governance?: GovernanceScope;
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------
export async function runEvals(options: RunOptions): Promise<RunReport> {
  const generators = options.generators ?? REAL_GENERATORS;
  const extractors = options.extractors ?? REAL_EXTRACTORS;
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();

  const filterIds = options.onlyCaseIds;
  const cases: readonly GoldenCase[] = filterIds
    ? GOLDEN_CASES.filter((c) => filterIds.includes(c.id))
    : GOLDEN_CASES.slice();

  const results: CaseReport[] = [];
  for (const c of cases) {
    const result = await runOneCase({
      caseDef: c,
      generators,
      extractors,
      judge: options.judge,
      specJudge: options.specJudge ?? false,
      governance: options.governance ?? {
        user_id: null,
        project_id: null,
        ref: 'evals.' + runId,
      },
    });
    results.push(result);
  }

  // -----------------------------------------------------------------
  // Aggregate — both tiers separately.
  // -----------------------------------------------------------------
  let genPassed = 0;
  let genTotal = 0;
  let genJudgedCases = 0;
  const judgedAcc: Record<string, { sum: number; n: number }> = {};
  for (const c of JUDGED_CRITERIA) judgedAcc[c.id] = { sum: 0, n: 0 };

  let specPassed = 0;
  let specTotal = 0;
  let specJudgedCases = 0;

  for (const r of results) {
    if ('passedCount' in r.structural) {
      genPassed += r.structural.passedCount;
      genTotal += r.structural.totalCount;
    }
    if (r.judged.status === 'completed') {
      genJudgedCases += 1;
      for (const [id, mean] of Object.entries(r.judged.criterionAverages)) {
        const slot = judgedAcc[id];
        if (slot && Number.isFinite(mean)) {
          slot.sum += mean;
          slot.n += 1;
        }
      }
    }
    if (
      r.specFidelity.structural &&
      'passedCount' in r.specFidelity.structural
    ) {
      specPassed += r.specFidelity.structural.passedCount;
      specTotal += r.specFidelity.structural.totalCount;
    }
    if (r.specFidelity.judged.status === 'completed') {
      specJudgedCases += 1;
    }
  }

  const judgedAverages: Record<string, number> = {};
  for (const c of JUDGED_CRITERIA) {
    const slot = judgedAcc[c.id];
    judgedAverages[c.id] = slot && slot.n > 0 ? slot.sum / slot.n : NaN;
  }

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    rubricVersion: RUBRIC_VERSION,
    specBarVersion: SPEC_QUALITY_BAR_VERSION,
    rubric: {
      structural: STRUCTURAL_CRITERIA.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
      })),
      judged: JUDGED_CRITERIA.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
      })),
    },
    meta: {
      generationMode: options.generationMode ?? 'real',
      extractionMode: options.extractionMode ?? 'real',
      judgeEnabled: options.judge,
      specJudgeEnabled: options.specJudge ?? false,
      judgeModel: options.judge ? readJudgeModel() : null,
      requireByok:
        (process.env.REQUIRE_BYOK ?? 'true').trim().toLowerCase() !== 'false',
    },
    cases: results,
    aggregate: {
      cases: results.length,
      structuralPassRate: genTotal === 0 ? NaN : genPassed / genTotal,
      judgedCriterionAverages: judgedAverages,
      judgedCasesScored: genJudgedCases,
      specStructuralPassRate: specTotal === 0 ? NaN : specPassed / specTotal,
      specJudgedCasesScored: specJudgedCases,
    },
  };
}

// ---------------------------------------------------------------------------
// One-case driver.
// ---------------------------------------------------------------------------
interface RunOneArgs {
  caseDef: GoldenCase;
  generators: Generators;
  extractors: Extractors;
  judge: boolean;
  specJudge: boolean;
  governance: GovernanceScope;
}

async function runOneCase(args: RunOneArgs): Promise<CaseReport> {
  const { caseDef, generators, extractors, judge, specJudge, governance } = args;

  // -----------------------------------------------------------------
  // 1. SPEC-FIDELITY TIER — always attempts extraction.
  // -----------------------------------------------------------------
  const specFidelity = await runSpecTier({
    caseDef,
    extractors,
    judge: specJudge,
    governance,
  });

  // -----------------------------------------------------------------
  // 2. GENERATION TIER — only for cases that have a plan. The infra
  //    case has plan=undefined (deterministic codegen, nothing to
  //    score against an LLM-driven generator).
  // -----------------------------------------------------------------
  if (caseDef.kind === 'infrastructure' || caseDef.plan === undefined) {
    return {
      case: caseSummary(caseDef),
      specFidelity,
      generation: {
        status: 'skipped',
        reason: 'no_llm_generation_for_this_mold',
        durationMs: 0,
        fileCount: 0,
      },
      structural: {
        status: 'skipped',
        reason: 'no_llm_generation_for_this_mold',
      },
      judged: {
        status: 'skipped',
        caseId: caseDef.id,
        reason: 'no_anthropic_key',
        modelUsed: null,
        fileScores: [],
        criterionAverages: emptyJudgedAverages(),
      },
    };
  }

  const start = Date.now();
  let unified: UnifiedGenFile[] | null = null;
  let gen: GenerationReport;
  try {
    switch (caseDef.kind) {
      case 'agent': {
        const summary = await generators.agent({
          spec: caseDef.spec,
          plan: caseDef.plan,
          governance: {
            ...governance,
            ref: (governance.ref ?? 'evals') + '.gen.' + caseDef.id,
          },
        });
        unified = summary.files.map((f) => ({
          path: f.path,
          content: f.content,
          source: f.source,
          staticCheck: f.staticCheck,
        }));
        gen = {
          status: 'completed',
          durationMs: Date.now() - start,
          fileCount: summary.files.length,
          llmFilesGenerated: summary.llmFilesGenerated,
          attempts: summary.attempts,
          modelsUsed: summary.models,
          warnings: summary.warnings,
        };
        break;
      }
      case 'system': {
        const summary = await generators.system({
          spec: caseDef.spec,
          plan: caseDef.plan,
          governance: {
            ...governance,
            ref: (governance.ref ?? 'evals') + '.gen.' + caseDef.id,
          },
        });
        unified = summary.files.map((f) => ({
          path: f.path,
          content: f.content,
          source: f.source,
          staticCheck: f.staticCheck,
        }));
        gen = {
          status: 'completed',
          durationMs: Date.now() - start,
          fileCount: summary.files.length,
          llmFilesGenerated: summary.modulesGenerated,
          attempts: summary.attempts,
          modelsUsed: summary.modelsUsed,
          warnings: summary.warnings.slice(),
        };
        break;
      }
      case 'software': {
        const summary = await generators.software({
          spec: caseDef.spec,
          plan: caseDef.plan,
          governance: {
            ...governance,
            ref: (governance.ref ?? 'evals') + '.gen.' + caseDef.id,
          },
        });
        unified = summary.files.map((f) => ({
          path: f.path,
          content: f.content,
          source: f.source,
          staticCheck: f.staticCheck,
        }));
        gen = {
          status: 'completed',
          durationMs: Date.now() - start,
          fileCount: summary.files.length,
          llmFilesGenerated: summary.slotCounts.llm,
          attempts: summary.attempts,
          modelsUsed: summary.modelsUsed.slice(),
          warnings: summary.warnings.slice(),
        };
        break;
      }
    }
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      return {
        case: caseSummary(caseDef),
        specFidelity,
        generation: {
          status: 'skipped',
          reason: 'no_anthropic_key',
          durationMs: Date.now() - start,
          fileCount: 0,
        },
        structural: { status: 'skipped', reason: 'no_anthropic_key' },
        judged: {
          status: 'skipped',
          caseId: caseDef.id,
          reason: 'no_anthropic_key',
          modelUsed: null,
          fileScores: [],
          criterionAverages: emptyJudgedAverages(),
        },
      };
    }
    if (err instanceof GovernanceError) {
      return {
        case: caseSummary(caseDef),
        specFidelity,
        generation: {
          status: 'skipped',
          reason: 'governance_blocked:' + err.reason,
          durationMs: Date.now() - start,
          fileCount: 0,
        },
        structural: {
          status: 'skipped',
          reason: 'governance_blocked:' + err.reason,
        },
        judged: {
          status: 'skipped',
          caseId: caseDef.id,
          reason: 'no_anthropic_key',
          modelUsed: null,
          fileScores: [],
          criterionAverages: emptyJudgedAverages(),
        },
      };
    }
    return {
      case: caseSummary(caseDef),
      specFidelity,
      generation: {
        status: 'failed',
        reason: err instanceof Error ? err.message : 'unknown generator error',
        durationMs: Date.now() - start,
        fileCount: 0,
      },
      structural: { status: 'skipped', reason: 'generation_failed' },
      judged: {
        status: 'skipped',
        caseId: caseDef.id,
        reason: 'no_anthropic_key',
        modelUsed: null,
        fileScores: [],
        criterionAverages: emptyJudgedAverages(),
      },
    };
  }

  const structural = scoreStructural({
    caseDef,
    files: unified!,
    rubricVersion: RUBRIC_VERSION,
  });
  const judged = await scoreJudged({
    caseDef,
    files: unified!,
    ref: 'gen.' + caseDef.id,
    enabled: judge,
  });

  return {
    case: caseSummary(caseDef),
    specFidelity,
    generation: gen,
    structural,
    judged,
  };
}

// ---------------------------------------------------------------------------
// Spec-fidelity tier driver.
// ---------------------------------------------------------------------------
interface RunSpecTierArgs {
  caseDef: GoldenCase;
  extractors: Extractors;
  judge: boolean;
  governance: GovernanceScope;
}

async function runSpecTier(args: RunSpecTierArgs): Promise<SpecFidelityReport> {
  const { caseDef, extractors, judge, governance } = args;
  const mold = caseDefMold(caseDef);
  const start = Date.now();
  let producedSpec: unknown = null;
  let extraction: ExtractionReport;

  try {
    const extractor = extractors[mold];
    const out = await extractor({
      rawPrompt: caseDef.intent,
      governance: {
        ...governance,
        ref: (governance.ref ?? 'evals') + '.spec.' + caseDef.id,
      },
    });
    producedSpec = out.result.spec;
    extraction = {
      status: 'completed',
      durationMs: Date.now() - start,
      attempts: out.attempts,
      model: out.model,
    };
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      return {
        extraction: {
          status: 'skipped',
          reason: 'no_anthropic_key',
          durationMs: Date.now() - start,
        },
        structural: {
          status: 'skipped',
          reason: 'no_anthropic_key',
        },
        judged: {
          status: 'skipped',
          caseId: caseDef.id,
          reason: 'extraction_skipped',
          modelUsed: null,
          scores: [],
          criterionAverages: emptySpecAverages(mold),
        },
      };
    }
    if (err instanceof GovernanceError) {
      return {
        extraction: {
          status: 'skipped',
          reason: 'governance_blocked:' + err.reason,
          durationMs: Date.now() - start,
        },
        structural: {
          status: 'skipped',
          reason: 'governance_blocked:' + err.reason,
        },
        judged: {
          status: 'skipped',
          caseId: caseDef.id,
          reason: 'extraction_skipped',
          modelUsed: null,
          scores: [],
          criterionAverages: emptySpecAverages(mold),
        },
      };
    }
    return {
      extraction: {
        status: 'failed',
        reason: err instanceof Error ? err.message : 'unknown extractor error',
        durationMs: Date.now() - start,
      },
      structural: { status: 'skipped', reason: 'extraction_failed' },
      judged: {
        status: 'skipped',
        caseId: caseDef.id,
        reason: 'extraction_skipped',
        modelUsed: null,
        scores: [],
        criterionAverages: emptySpecAverages(mold),
      },
    };
  }

  // Structural ALWAYS runs when we have a produced spec.
  const structural = scoreSpecStructural({
    caseDef,
    producedSpec,
    producedMold: mold,
    specBarVersion: SPEC_QUALITY_BAR_VERSION,
  });

  // Judged tier — key-gated.
  const judged = await scoreSpecJudged({
    caseDef,
    producedSpec,
    producedMold: mold,
    ref: caseDef.id,
    enabled: judge,
  });

  return { extraction, structural, judged };
}

function caseDefMold(caseDef: GoldenCase): SpecMold {
  if (caseDef.kind === 'infrastructure') return 'infrastructure';
  return caseDef.kind;
}

function caseSummary(c: GoldenCase): CaseReport['case'] {
  return { id: c.id, kind: c.kind, description: c.description };
}

function emptyJudgedAverages(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of JUDGED_CRITERIA) out[c.id] = NaN;
  return out;
}

function emptySpecAverages(mold: SpecMold): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of collectMoldIds(mold)) out[id] = NaN;
  return out;
}

function readJudgeModel(): string {
  return process.env.EVAL_JUDGE_MODEL?.trim() || 'claude-haiku-4-5';
}
