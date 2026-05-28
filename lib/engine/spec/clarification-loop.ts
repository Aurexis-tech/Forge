// BOUNDED CLARIFICATION LOOP — orchestrates ambiguity detection →
// smart question → user answer → re-extract → recompute, capped at
// MAX_CLARIFICATION_ROUNDS rounds.
//
// PLUGGABLE SEAMS for tests:
//
//   - `extract` — given an intent, return { spec, confidence }.
//     Production callers pass a thin wrapper over the real per-mold
//     extractor; tests pass a stub.
//
//   - `ask` — given a question, return the user's answer string.
//     Production callers wire this to the UI / HTTP round-trip.
//     Tests pass a scripted answer function.
//
//   - `phrase` (optional) — given a question template, return a more
//     natural-language version. Used to POLISH the deterministic
//     template; the SELECTION of which uncertainty to ask about is
//     done by the deterministic selector. When omitted the template
//     is used verbatim. This is the one place a small LLM call may
//     live; tests omit it.
//
//   - `audit` (optional) — per-round side-effect hook. Production
//     callers pass an `auditClarificationRound` that writes to the
//     audit_log table. Tests assert this is called.
//
// HARD INVARIANTS
//   - MAX_CLARIFICATION_ROUNDS rounds, env-overridable. After max
//     rounds the loop stops and surfaces remaining uncertainty to
//     the caller — the show-spec gate (UI improvement is next).
//   - A round runs only if the current uncertainty report has
//     hasActionable === true. Otherwise short-circuit immediately.
//   - Governance scope is threaded through `phrase` so the cost
//     ledger attributes the wording call to the right user/project.

import type { GovernanceScope } from '../llm';
import type { SpecMold } from './quality';
import {
  computeConfidence,
  type SpecConfidence,
} from './confidence';
import {
  detectUncertainty,
  selectClarification,
  type UncertaintyReport,
} from './uncertainty';

// ---------------------------------------------------------------------------
// Engine-owned constants. Bumping MAX_CLARIFICATION_ROUNDS is a
// deliberate change — the loop is bounded BY DESIGN.
// ---------------------------------------------------------------------------
const DEFAULT_MAX_ROUNDS = 2;

/** The hard cap on rounds. Env-overridable. Always >= 0. */
export function maxClarificationRounds(): number {
  const raw = process.env.MAX_CLARIFICATION_ROUNDS;
  if (raw === undefined) return DEFAULT_MAX_ROUNDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_ROUNDS;
  // Hard sanity ceiling: 10. Anything beyond is almost certainly
  // a misconfiguration; we'd rather show the gate than chase the
  // model in circles. Keep cheap and bounded.
  return Math.min(parsed, 10);
}

// ---------------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------------
export interface ClarificationRound {
  /** The question shown to the user (post-phrase if phraser supplied). */
  readonly question: string;
  /** The user's answer. */
  readonly answer: string;
  /** The field that was clarified this round. */
  readonly field: string;
  /** Uncertainty count BEFORE this round ran. */
  readonly uncertaintyBefore: number;
  /** Uncertainty count AFTER re-extraction. */
  readonly uncertaintyAfter: number;
}

export type LoopTermination = 'converged' | 'max_rounds_reached' | 'no_actionable';

export interface ClarificationLoopResult {
  readonly finalSpec: unknown;
  readonly finalConfidence: SpecConfidence;
  readonly finalUncertainty: UncertaintyReport;
  readonly rounds: ReadonlyArray<ClarificationRound>;
  readonly terminated: LoopTermination;
  /** The final intent string (initial + all clarifications appended). */
  readonly enrichedIntent: string;
}

// ---------------------------------------------------------------------------
// Pluggable extractor seam — wraps the real per-mold extractor so
// the loop only sees a uniform (intent → spec) shape.
// ---------------------------------------------------------------------------
export interface ExtractForLoop {
  (intent: string, governance: GovernanceScope): Promise<{ spec: unknown }>;
}

export interface AuditClarificationRound {
  (event: {
    round: number;
    field: string;
    uncertaintyBefore: number;
    uncertaintyAfter: number;
    governance: GovernanceScope;
  }): Promise<void> | void;
}

export interface AuditMaxReached {
  (event: {
    rounds: number;
    remainingUncertaintyCount: number;
    governance: GovernanceScope;
  }): Promise<void> | void;
}

export interface AuditResolved {
  (event: {
    rounds: number;
    governance: GovernanceScope;
  }): Promise<void> | void;
}

export interface RunClarificationLoopArgs {
  /** The original natural-language intent. */
  intent: string;
  /** Which mold the extractor is for (drives confidence + leverage tables). */
  mold: SpecMold;
  /** Extracts a spec from an intent. */
  extract: ExtractForLoop;
  /** Asks the user a question; resolves with their answer. */
  ask: (question: string) => Promise<string>;
  /**
   * OPTIONAL phraser — turns the deterministic template into a more
   * natural-sounding question. When absent, the template is used
   * verbatim. The phraser is the ONE place the loop may issue an
   * LLM call; gate it via the caller's BYOK + governance.
   */
  phrase?: (template: string, governance: GovernanceScope) => Promise<string>;
  /** Governance threading. */
  governance: GovernanceScope;
  /** Optional audit hooks — production callers wire these to audit_log. */
  audit?: {
    round?: AuditClarificationRound;
    maxReached?: AuditMaxReached;
    resolved?: AuditResolved;
  };
  /** Override the global max (used by tests to assert the cap). */
  maxRounds?: number;
}

// ---------------------------------------------------------------------------
// Main entry — bounded, deterministic, side-effects via the audit
// hooks only.
// ---------------------------------------------------------------------------
export async function runClarificationLoop(
  args: RunClarificationLoopArgs,
): Promise<ClarificationLoopResult> {
  const cap = args.maxRounds ?? maxClarificationRounds();
  let intent = args.intent;
  const rounds: ClarificationRound[] = [];

  // Pass 0 — initial extraction.
  const initial = await args.extract(intent, scopedRef(args.governance, 'initial'));
  let currentSpec: unknown = initial.spec;
  let currentConfidence = computeConfidence(args.mold, currentSpec, intent);
  let currentUncertainty = detectUncertainty({
    mold: args.mold,
    spec: currentSpec,
    confidence: currentConfidence,
    intent,
  });

  // Short-circuit when nothing actionable.
  if (!currentUncertainty.hasActionable) {
    return {
      finalSpec: currentSpec,
      finalConfidence: currentConfidence,
      finalUncertainty: currentUncertainty,
      rounds,
      terminated: 'no_actionable',
      enrichedIntent: intent,
    };
  }

  // Iterate up to the cap.
  while (rounds.length < cap && currentUncertainty.hasActionable) {
    const selected = selectClarification(currentUncertainty);
    if (selected === null) break;
    // Phrase (optional) — falls back to the deterministic template.
    const question = args.phrase
      ? await args.phrase(
          selected.question,
          scopedRef(args.governance, 'phrase.' + selected.entry.field),
        )
      : selected.question;
    const answer = await args.ask(question);
    const uncertaintyBefore = currentUncertainty.entries.length;

    // Append the clarification to the intent + re-extract. This is
    // the SAME shape the per-mold extractors take in their
    // `answers` parameter, but the loop deliberately appends as
    // plain prose so the model sees a single coherent intent.
    intent = intent + '\n\nClarification:\n  Q: ' + question + '\n  A: ' + answer;
    const nextExtraction = await args.extract(
      intent,
      scopedRef(args.governance, 'round.' + (rounds.length + 1)),
    );
    currentSpec = nextExtraction.spec;
    currentConfidence = computeConfidence(args.mold, currentSpec, intent);
    currentUncertainty = detectUncertainty({
      mold: args.mold,
      spec: currentSpec,
      confidence: currentConfidence,
      intent,
    });
    const uncertaintyAfter = currentUncertainty.entries.length;

    rounds.push({
      question,
      answer,
      field: selected.entry.field,
      uncertaintyBefore,
      uncertaintyAfter,
    });

    if (args.audit?.round) {
      await args.audit.round({
        round: rounds.length,
        field: selected.entry.field,
        uncertaintyBefore,
        uncertaintyAfter,
        governance: args.governance,
      });
    }
  }

  // Termination classification.
  let terminated: LoopTermination;
  if (!currentUncertainty.hasActionable) {
    terminated = 'converged';
    if (args.audit?.resolved) {
      await args.audit.resolved({
        rounds: rounds.length,
        governance: args.governance,
      });
    }
  } else {
    terminated = 'max_rounds_reached';
    if (args.audit?.maxReached) {
      await args.audit.maxReached({
        rounds: rounds.length,
        remainingUncertaintyCount: currentUncertainty.entries.length,
        governance: args.governance,
      });
    }
  }

  return {
    finalSpec: currentSpec,
    finalConfidence: currentConfidence,
    finalUncertainty: currentUncertainty,
    rounds,
    terminated,
    enrichedIntent: intent,
  };
}

function scopedRef(governance: GovernanceScope, suffix: string): GovernanceScope {
  return {
    ...governance,
    ref: (governance.ref ?? 'spec.clarification') + '.' + suffix,
  };
}
