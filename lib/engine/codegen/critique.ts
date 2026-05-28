// CRITIQUE-AND-REFINE — leg 3 of the output-quality loop.
//
// Closes the INSTRUCT → MEASURE → CRITIQUE → REFINE loop, all
// against ONE engine-owned QUALITY_BAR (lib/engine/codegen/
// quality.ts). After a generated file passes static-check, the
// engine critiques its own output against the same bar it was
// instructed against; if the critique flags issues, refines once.
//
// OFF BY DEFAULT — CRITIQUE_GATE_ENABLED='false' is the default.
// Per-forge cost stays predictable; teams flip it on when quality
// matters more than cost.
//
// HARD INVARIANTS
//   - Reuses the engine-owned QUALITY_BAR. NO separate "critique
//     bar." The critic scores against the exact criteria the
//     prompt builder + eval rubric reference.
//   - Bounded at 1 refine round. No retry loops. No nested
//     critique-of-critique.
//   - We NEVER make good code worse. If the refined output fails
//     static-check, we fall back to the original (which already
//     passed). The static-check is the safety net.
//   - Existing self-heal (in generate.ts / slots.ts) runs FIRST
//     on static-check failure — they don't overlap. Self-heal
//     fixes "doesn't compile"; critique-refine improves "compiles
//     but mediocre."
//   - Every critique + refine call routes through complete() →
//     governance gate → ledger. Cost ref pattern:
//     `<base>.critique` and `<base>.refine` so the ledger shows
//     gate spend independently and observably.
//   - Audit hooks are OPTIONAL; the helper calls them when wired.
//     They never see code text or critique text — only meta
//     (counts, met/unmet per criterion, file path).

import {
  complete,
  LLMError,
  type GovernanceScope,
} from '../llm';
import { staticCheckFile } from './staticcheck';
import {
  QUALITY_BAR,
  QUALITY_BAR_VERSION,
  qualityBarPromptBullets,
  type QualityBarId,
} from './quality';

// ===========================================================================
// CONFIG — engine-owned constants. Env-readable.
// ===========================================================================

// Haiku-tier model id. Same default as the eval-judge tier so they
// share cost characteristics. Override per env if needed; tests can
// stub `complete` directly.
const DEFAULT_CRITIQUE_MODEL = 'claude-haiku-4-5';

/**
 * Whether the critique-refine gate runs at all. Default 'false' —
 * leave the per-forge cost predictable. Set to 'true' / '1' / 'on'
 * to enable.
 */
export function isCritiqueGateEnabled(): boolean {
  const raw = (process.env.CRITIQUE_GATE_ENABLED ?? 'false').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
}

/**
 * Minimum overall_score that lets the original code pass through
 * untouched. Default 4 (out of 5) — meaning "good enough." Anything
 * below this triggers a refine pass. Env override:
 * CRITIQUE_GATE_THRESHOLD.
 */
export function getCritiqueThreshold(): number {
  const raw = process.env.CRITIQUE_GATE_THRESHOLD;
  if (raw === undefined) return 4;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.max(1, Math.min(5, parsed));
}

/** Model id used by the critique pass. */
export function getCritiqueModel(): string {
  return process.env.CRITIQUE_GATE_MODEL?.trim() || DEFAULT_CRITIQUE_MODEL;
}

// ===========================================================================
// PUBLIC SHAPES
// ===========================================================================

export interface CritiqueCriterionResult {
  readonly id: QualityBarId;
  readonly met: boolean;
  readonly score: number; // 1-5
  readonly note: string; // <= 200 chars
}

export interface CritiqueResult {
  readonly overall_score: number; // 1-5
  readonly criteria: ReadonlyArray<CritiqueCriterionResult>;
  readonly suggestions: ReadonlyArray<string>;
  /** Model id that produced the critique. */
  readonly modelUsed: string;
  /** True when overall_score >= threshold AND every criterion is met. */
  readonly passesThreshold: boolean;
}

export type CritiqueDecision =
  | 'skipped'
  | 'kept_original'
  | 'used_refined'
  | 'fallback_to_original_on_refine_fail';

export interface CritiqueAndRefineResult {
  /** The code to use downstream. */
  readonly code: string;
  /** Which path produced `code`. */
  readonly source: 'original' | 'refined';
  /** Outcome classification. */
  readonly decision: CritiqueDecision;
  /** The critique verdict (present unless decision is 'skipped'). */
  readonly critique: CritiqueResult | null;
}

// Pluggable seam for the refine pass. Production callers close
// over the relevant generator context (prompts + spec/plan); tests
// pass a stub.
export interface RegenerateForRefine {
  (args: {
    /** The original code that passed static-check. */
    previousCode: string;
    /** The critique verdict — implementations should append the
     *  notes + suggestions to the regenerated prompt. */
    critique: CritiqueResult;
    /** Governance scope already namespaced with `.refine`. */
    governance: GovernanceScope;
  }): Promise<string>;
}

// Audit hook contract. Each is optional; outer callers (with
// supabase access) wire what they need. The helper passes meta
// only — counts + per-criterion met/unmet + file path. Never the
// code text, never the critique note text.
export interface CritiqueAuditHooks {
  /** Fires when the critique LLM call is about to be made. */
  critiqueStarted?: (event: {
    readonly filePath: string;
    readonly governance: GovernanceScope;
  }) => Promise<void> | void;
  /** Fires with the critique verdict. */
  critiqueCompleted?: (event: {
    readonly filePath: string;
    readonly overallScore: number;
    readonly criteriaMet: number;
    readonly criteriaTotal: number;
    readonly passesThreshold: boolean;
    readonly governance: GovernanceScope;
  }) => Promise<void> | void;
  /** Fires when the threshold check fails and refine is about to run. */
  refineTriggered?: (event: {
    readonly filePath: string;
    readonly overallScore: number;
    readonly governance: GovernanceScope;
  }) => Promise<void> | void;
  /** Fires when the refined output replaces the original. */
  refineUsed?: (event: {
    readonly filePath: string;
    readonly governance: GovernanceScope;
  }) => Promise<void> | void;
  /** Fires when refine failed static-check (or threw); original kept. */
  refineRejectedFallback?: (event: {
    readonly filePath: string;
    readonly reason: 'static_check_failed' | 'regenerate_error';
    readonly governance: GovernanceScope;
  }) => Promise<void> | void;
}

export interface CritiqueAndRefineArgs {
  /** Code that has already passed static-check. */
  readonly code: string;
  /** File path — used for static-checking the refined output + audit. */
  readonly filePath: string;
  /** Plain-English purpose; included in the critique prompt. */
  readonly filePurpose: string;
  /**
   * Optional spec / plan summary surfaced to the critic. The critic
   * uses it to judge spec_fidelity-style criteria. Keep it short —
   * a 1-3 sentence anchor, not a JSON dump.
   */
  readonly specSummary?: string;
  /** Pluggable refine seam. */
  readonly regenerate: RegenerateForRefine;
  /** Governance scope; the helper appends `.critique` + `.refine` refs. */
  readonly governance: GovernanceScope;
  /** Optional audit hooks. */
  readonly audit?: CritiqueAuditHooks;
}

// ===========================================================================
// MAIN ENTRY
// ===========================================================================

export async function critiqueAndRefine(
  args: CritiqueAndRefineArgs,
): Promise<CritiqueAndRefineResult> {
  // Short-circuit when the flag is off (the default).
  if (!isCritiqueGateEnabled()) {
    return {
      code: args.code,
      source: 'original',
      decision: 'skipped',
      critique: null,
    };
  }

  // ----- Critique pass -----
  if (args.audit?.critiqueStarted) {
    await args.audit.critiqueStarted({
      filePath: args.filePath,
      governance: args.governance,
    });
  }

  const critique = await runCritique({
    code: args.code,
    filePath: args.filePath,
    filePurpose: args.filePurpose,
    specSummary: args.specSummary,
    governance: critiqueGovernance(args.governance),
  });

  if (args.audit?.critiqueCompleted) {
    await args.audit.critiqueCompleted({
      filePath: args.filePath,
      overallScore: critique.overall_score,
      criteriaMet: critique.criteria.filter((c) => c.met).length,
      criteriaTotal: critique.criteria.length,
      passesThreshold: critique.passesThreshold,
      governance: args.governance,
    });
  }

  if (critique.passesThreshold) {
    return {
      code: args.code,
      source: 'original',
      decision: 'kept_original',
      critique,
    };
  }

  // ----- Refine pass -----
  if (args.audit?.refineTriggered) {
    await args.audit.refineTriggered({
      filePath: args.filePath,
      overallScore: critique.overall_score,
      governance: args.governance,
    });
  }

  let refinedCode: string;
  try {
    refinedCode = await args.regenerate({
      previousCode: args.code,
      critique,
      governance: refineGovernance(args.governance),
    });
  } catch (err) {
    if (args.audit?.refineRejectedFallback) {
      await args.audit.refineRejectedFallback({
        filePath: args.filePath,
        reason: 'regenerate_error',
        governance: args.governance,
      });
    }
    return {
      code: args.code,
      source: 'original',
      decision: 'fallback_to_original_on_refine_fail',
      critique,
    };
  }

  // Static-check the refined output. The refined code MUST pass
  // for us to use it — we never ship code worse than the original.
  const check = await staticCheckFile(args.filePath, refinedCode);
  if (!check.ok) {
    if (args.audit?.refineRejectedFallback) {
      await args.audit.refineRejectedFallback({
        filePath: args.filePath,
        reason: 'static_check_failed',
        governance: args.governance,
      });
    }
    return {
      code: args.code,
      source: 'original',
      decision: 'fallback_to_original_on_refine_fail',
      critique,
    };
  }

  if (args.audit?.refineUsed) {
    await args.audit.refineUsed({
      filePath: args.filePath,
      governance: args.governance,
    });
  }

  return {
    code: refinedCode,
    source: 'refined',
    decision: 'used_refined',
    critique,
  };
}

// ===========================================================================
// CRITIQUE LLM CALL
// ===========================================================================

const CRITIQUE_SYSTEM_PROMPT =
  'You are a code-quality critic for the Aurexis Forge codegen worker. You are given ONE file that has just passed static-check (esbuild parsed it cleanly). Your job is to assess whether the file meets the engine\'s QUALITY BAR. You are scoring CODE QUALITY, not compilation — compilation is already proven.\n\n' +
  'Be calibrated: 3 means "average machine-generated code"; 5 is reserved for code that is genuinely idiomatic, complete, and matches the spec; 1 means the criterion is plainly violated. `met` should be TRUE only when the score is >= 4. When uncertain, mark `met=false` and let the engine decide whether to refine.\n\n' +
  'Reply with a SINGLE JSON object and nothing else. Schema:\n' +
  '{\n' +
  '  "criteria": [\n' +
  '    { "id": "<criterion id>", "met": <true|false>, "score": <1-5 integer>, "note": "<<= 120 chars>" }\n' +
  '  ],\n' +
  '  "overall_score": <1-5 integer>,\n' +
  '  "suggestions": ["<concrete improvement, <= 160 chars>", ...]   // max 5\n' +
  '}\n\n' +
  'Include EXACTLY ONE entry per QUALITY BAR criterion id. No missing, no extra. No prose outside the JSON. No code fences.';

interface RunCritiqueArgs {
  code: string;
  filePath: string;
  filePurpose: string;
  specSummary?: string;
  governance: GovernanceScope;
}

async function runCritique(args: RunCritiqueArgs): Promise<CritiqueResult> {
  const userMessage = buildCritiqueUserMessage(args);
  let res;
  try {
    res = await complete({
      model: getCritiqueModel(),
      system: CRITIQUE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 800,
      governance: args.governance,
    });
  } catch (err) {
    if (err instanceof LLMError) {
      // Treat LLM errors as a non-fatal critique miss — produce a
      // neutral verdict that triggers refine (score 3, not met).
      // The refine pass will either improve the code or fall back.
      return neutralCritiqueResult(getCritiqueModel());
    }
    throw err;
  }

  try {
    return parseCritiqueReply(res.text, res.model);
  } catch {
    // Parsing failure → same neutral verdict. We don't propagate
    // the error because the calling generator already has a valid
    // candidate; we just couldn't grade it.
    return neutralCritiqueResult(res.model);
  }
}

function buildCritiqueUserMessage(args: RunCritiqueArgs): string {
  return [
    'FILE PATH: ' + args.filePath,
    'FILE PURPOSE: ' + args.filePurpose,
    args.specSummary ? 'SPEC SUMMARY: ' + args.specSummary : null,
    '',
    'QUALITY BAR (v' + QUALITY_BAR_VERSION + ') — score against every entry:',
    qualityBarPromptBullets(),
    '',
    'FILE CONTENT (delimited):',
    '<<<FILE>>>',
    args.code,
    '<<<END>>>',
    '',
    'Return ONLY the JSON object described in the system prompt.',
  ]
    .filter((s): s is string => s !== null)
    .join('\n');
}

function neutralCritiqueResult(model: string): CritiqueResult {
  return {
    overall_score: 3,
    criteria: QUALITY_BAR.map(
      (c): CritiqueCriterionResult => ({
        id: c.id as QualityBarId,
        met: false,
        score: 3,
        note: '(critic unavailable — neutral score)',
      }),
    ),
    suggestions: [],
    modelUsed: model,
    passesThreshold: false, // forces refine to attempt
  };
}

// ===========================================================================
// JSON EXTRACTION + VALIDATION
// ===========================================================================

function extractCritiqueJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence && typeof fence[1] === 'string') {
    return JSON.parse(fence[1]);
  }
  const open = trimmed.indexOf('{');
  const close = trimmed.lastIndexOf('}');
  if (open >= 0 && close > open) {
    return JSON.parse(trimmed.slice(open, close + 1));
  }
  throw new Error('critic did not return JSON');
}

function parseCritiqueReply(text: string, model: string): CritiqueResult {
  const parsed = extractCritiqueJson(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('critique payload is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const rawCriteria = obj.criteria;
  if (!Array.isArray(rawCriteria)) {
    throw new Error('critique.criteria is missing or not an array');
  }
  const byId = new Map<string, CritiqueCriterionResult>();
  for (const raw of rawCriteria) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : null;
    if (!id) continue;
    const score = clampScore(r.score);
    const met = typeof r.met === 'boolean' ? r.met : score >= 4;
    const note = typeof r.note === 'string' ? r.note.slice(0, 200) : '';
    byId.set(id, { id: id as QualityBarId, met, score, note });
  }
  // Fill in any QUALITY_BAR criterion the critic skipped — neutral
  // 3/5, met=false (the engine treats unknown as worth refining).
  const criteria: CritiqueCriterionResult[] = QUALITY_BAR.map(
    (c): CritiqueCriterionResult =>
      byId.get(c.id) ?? {
        id: c.id as QualityBarId,
        met: false,
        score: 3,
        note: '(critic skipped this criterion)',
      },
  );
  const overall_score = clampScore(obj.overall_score);
  const suggestions = Array.isArray(obj.suggestions)
    ? (obj.suggestions as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.slice(0, 200))
        .slice(0, 5)
    : [];
  const allMet = criteria.every((c) => c.met);
  return {
    overall_score,
    criteria,
    suggestions,
    modelUsed: model,
    passesThreshold: overall_score >= getCritiqueThreshold() && allMet,
  };
}

function clampScore(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(5, Math.round(v)));
}

// ===========================================================================
// REFINEMENT PROMPT BUILDER — exported for integration sites that
// build the regenerate closure. Single source of truth for the
// "here's what's wrong, please fix" message shape.
// ===========================================================================

/**
 * Build the additional context message that integration sites
 * append to the original generator prompt when re-calling the
 * model for the refine pass. Reusing the original prompt builder +
 * appending this message keeps the QUALITY_BAR + exemplar +
 * file-purpose context intact; only the critique is new.
 */
export function buildRefinementContextMessage(
  critique: CritiqueResult,
  previousCode: string,
): string {
  const scoreLines = critique.criteria.map(
    (c) =>
      '  - ' +
      c.id +
      ': ' +
      c.score +
      '/5 ' +
      (c.met ? '(met)' : '(NOT met)') +
      (c.note ? ' — ' + c.note : ''),
  );
  const suggestionLines =
    critique.suggestions.length === 0
      ? ['  (no specific suggestions — re-read the QUALITY BAR + improve the weakest criteria above)']
      : critique.suggestions.map((s) => '  - ' + s);
  return [
    'Your previous output PASSED static-check but a quality critic graded it ' +
      critique.overall_score +
      '/5 against the QUALITY BAR.',
    '',
    'CRITIQUE SCORES:',
    ...scoreLines,
    '',
    'CRITIC SUGGESTIONS:',
    ...suggestionLines,
    '',
    'YOUR PREVIOUS OUTPUT (the code you are improving):',
    '<<<PREVIOUS>>>',
    previousCode,
    '<<<END>>>',
    '',
    'RE-GENERATE THE FILE applying the critique. Keep the same exports + imports. Output ONLY the file contents — no fences, no prose. Meet the QUALITY BAR.',
  ].join('\n');
}

// ===========================================================================
// GOVERNANCE NAMESPACING — single source of truth for the refs that
// land in the cost ledger. Other callers can read these to query
// the ledger for critique vs refine spend per file.
// ===========================================================================
export const CRITIQUE_REF_SUFFIX = 'critique';
export const REFINE_REF_SUFFIX = 'refine';

function critiqueGovernance(base: GovernanceScope): GovernanceScope {
  return {
    ...base,
    ref: (base.ref ?? 'codegen') + '.' + CRITIQUE_REF_SUFFIX,
  };
}

function refineGovernance(base: GovernanceScope): GovernanceScope {
  return {
    ...base,
    ref: (base.ref ?? 'codegen') + '.' + REFINE_REF_SUFFIX,
  };
}
