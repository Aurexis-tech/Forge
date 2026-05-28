// Judged scoring tier — LLM-AS-JUDGE.
//
// Shows the rubric's judged criteria to a CHEAP Haiku-tier model and
// asks for a 1-5 score + a short note per criterion, per sampled
// file. This tier costs real money to run; it is GATED behind a
// model key and SKIPPED + flagged when none is set.
//
// Reuses the same `complete()` seam every other LLM call goes
// through — same key resolution, same governance guard, same cost
// ledger. A judged run is funded fuel just like a generation run.
//
// COST POSTURE
//   - Sampled files only (not every file): up to JUDGE_SAMPLE_PER_CASE.
//   - Single LLM call per sampled file, scoring all criteria at once.
//   - Haiku-tier model (JUDGE_MODEL). The harness still records cost
//     to the ledger; the user funds the run.
//
// NEVER runs implicitly — the runner sets allowReal=true only when
// the caller explicitly asked for the judged tier.

import { complete, type GovernanceScope } from '@/lib/engine/llm';
import { NeedsKeyError, peekKeySource } from '@/lib/engine/keys';
import type { GoldenCase } from './golden';
import { JUDGED_CRITERIA } from './rubric';
import type { UnifiedGenFile } from './structural';

// Haiku-tier. We pin the model id here rather than reuse CODEGEN_MODEL
// because the codegen model is intentionally beefier — judging is
// cheap by design.
export const JUDGE_MODEL =
  process.env.EVAL_JUDGE_MODEL?.trim() || 'claude-haiku-4-5';

// Sampling cap — how many files to ask the judge about per case.
// Picked to keep judged runs cheap (3 files × ~1k tokens × 3 cases
// is well under a cent against Haiku as of 2025).
export const JUDGE_SAMPLE_PER_CASE = 3;

// Per-file char ceiling fed to the judge. Truncation is honest —
// the judge sees a head-and-tail slice of the file with a marker.
export const JUDGE_FILE_MAX_CHARS = 4_000;

export interface JudgedCriterionScore {
  /** id from JUDGED_CRITERIA */
  id: string;
  /** 1 (worst) - 5 (best). NaN when the judge refused to score. */
  score: number;
  /** Short justification — capped before the judge call. */
  note: string;
}

export interface JudgedFileScore {
  path: string;
  scores: JudgedCriterionScore[];
  // Raw model text when parsing failed; null when parsing succeeded.
  rawOnError: string | null;
}

export type JudgedReport =
  | {
      status: 'skipped';
      caseId: string;
      reason: 'no_anthropic_key' | 'disabled';
      modelUsed: null;
      fileScores: never[];
      criterionAverages: Record<string, number>;
    }
  | {
      status: 'completed';
      caseId: string;
      modelUsed: string;
      fileScores: JudgedFileScore[];
      // criterion id -> mean across sampled files (NaN excluded).
      criterionAverages: Record<string, number>;
      // Token usage across the case — fed into the run report so a
      // user can see what each case cost.
      usage: { input_tokens: number; output_tokens: number };
    }
  | {
      status: 'failed';
      caseId: string;
      modelUsed: string;
      error: string;
      fileScores: JudgedFileScore[];
      criterionAverages: Record<string, number>;
    };

// ---------------------------------------------------------------------------
// Sampling — choose which files the judge looks at.
//
// Per case:
//   1. The entrypoint, if defined and present.
//   2. The first N additional `source: 'generated'` files in path
//      order, up to the case cap. We exclude scaffold files because
//      they're hand-authored — the judge has no signal to add there.
// ---------------------------------------------------------------------------
export function sampleFilesForJudging(
  caseDef: GoldenCase,
  files: readonly UnifiedGenFile[],
  cap: number = JUDGE_SAMPLE_PER_CASE,
): UnifiedGenFile[] {
  const picked: UnifiedGenFile[] = [];
  const seen = new Set<string>();

  // 1. Entrypoint first.
  const ep = caseDef.contract.entrypointPath;
  if (ep) {
    const epFile = files.find((f) => f.path === ep);
    if (epFile) {
      picked.push(epFile);
      seen.add(epFile.path);
    }
  }

  // 2. Fill the rest from generated (non-scaffold) files.
  const generated = files
    .filter((f) => f.source === 'generated' && !seen.has(f.path))
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const f of generated) {
    if (picked.length >= cap) break;
    picked.push(f);
    seen.add(f.path);
  }
  return picked;
}

function truncateForJudge(content: string): string {
  if (content.length <= JUDGE_FILE_MAX_CHARS) return content;
  const head = Math.floor((JUDGE_FILE_MAX_CHARS * 2) / 3);
  const tail = JUDGE_FILE_MAX_CHARS - head;
  return (
    content.slice(0, head) +
    '\n\n// … [' +
    String(content.length - JUDGE_FILE_MAX_CHARS) +
    ' chars elided] …\n\n' +
    content.slice(-tail)
  );
}

// ---------------------------------------------------------------------------
// Prompt construction.
//
// The judge sees: (a) the rubric criteria, (b) the case description
// + spec goal, (c) one generated file. It is asked to reply with a
// strict JSON object so we can parse without an extra round-trip.
// ---------------------------------------------------------------------------
const JUDGE_SYSTEM_PROMPT =
  'You are a code-review judge for an automated codegen system. You will be ' +
  'given ONE generated file plus a rubric of evaluation criteria. Score each ' +
  'criterion 1 (worst) to 5 (best). Be calibrated: 3 means "average for ' +
  'machine-generated code"; 5 is reserved for code that is genuinely ' +
  'idiomatic, complete, and matches the spec; 1 means the criterion is ' +
  'plainly violated.\n\n' +
  'Reply with a SINGLE JSON object and nothing else. The object must have ' +
  'the shape:\n' +
  '{\n' +
  '  "scores": [\n' +
  '    { "id": "<criterion id>", "score": <integer 1-5>, "note": "<<=120 chars>" }\n' +
  '  ]\n' +
  '}\n\n' +
  'Include exactly one entry per criterion id in the rubric. No prose ' +
  'outside the JSON. No code fences.';

function buildJudgeUserMessage(args: {
  caseDescription: string;
  caseGoal: string;
  filePath: string;
  fileSource: 'scaffold' | 'generated';
  fileContent: string;
}): string {
  const rubricLines = JUDGED_CRITERIA.map(
    (c) => '- ' + c.id + ' :: ' + c.label + ' — ' + c.description,
  ).join('\n');
  return (
    'CASE: ' +
    args.caseDescription +
    '\nSPEC GOAL: ' +
    args.caseGoal +
    '\n\nFILE: ' +
    args.filePath +
    ' (source=' +
    args.fileSource +
    ')\n\n--- begin file ---\n' +
    truncateForJudge(args.fileContent) +
    '\n--- end file ---\n\nRUBRIC:\n' +
    rubricLines +
    '\n\nReturn ONLY the JSON object described in the system prompt.'
  );
}

// ---------------------------------------------------------------------------
// JSON extraction — robust to occasional fenced replies despite the
// system prompt. We accept a fenced ```json … ``` block too.
// ---------------------------------------------------------------------------
function extractJudgeJson(text: string): unknown {
  const trimmed = text.trim();
  // Try direct parse first.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // Strip a single fenced block if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence && typeof fence[1] === 'string') {
    return JSON.parse(fence[1]);
  }
  // Try to find the first { … } substring.
  const open = trimmed.indexOf('{');
  const close = trimmed.lastIndexOf('}');
  if (open >= 0 && close > open) {
    return JSON.parse(trimmed.slice(open, close + 1));
  }
  throw new Error('judge did not return JSON');
}

function parseJudgeReply(text: string): JudgedCriterionScore[] {
  const parsed = extractJudgeJson(text);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { scores?: unknown }).scores)
  ) {
    throw new Error('judge reply did not contain a scores array');
  }
  const raw = (parsed as { scores: unknown[] }).scores;
  const byId = new Map<string, JudgedCriterionScore>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : null;
    if (!id) continue;
    const scoreRaw = e.score;
    const score =
      typeof scoreRaw === 'number'
        ? Math.max(1, Math.min(5, Math.round(scoreRaw)))
        : NaN;
    const note =
      typeof e.note === 'string' ? e.note.slice(0, 200) : '';
    byId.set(id, { id, score, note });
  }
  // Fill in any criterion the judge skipped — NaN score so the
  // averager excludes it.
  return JUDGED_CRITERIA.map(
    (c): JudgedCriterionScore =>
      byId.get(c.id) ?? { id: c.id, score: NaN, note: '(no score returned)' },
  );
}

// ---------------------------------------------------------------------------
// Public entry — key-gated. Reports `skipped` cleanly when no key.
// ---------------------------------------------------------------------------
export interface ScoreJudgedArgs {
  caseDef: GoldenCase;
  files: readonly UnifiedGenFile[];
  // Free-form ref for the ledger so this judged run is greppable.
  ref: string;
  // Setting this to false unconditionally skips. The runner only
  // sets it true when the user opted in via `--judge` / env.
  enabled: boolean;
}

export async function scoreJudged(
  args: ScoreJudgedArgs,
): Promise<JudgedReport> {
  if (!args.enabled) {
    return {
      status: 'skipped',
      caseId: args.caseDef.id,
      reason: 'disabled',
      modelUsed: null,
      fileScores: [],
      criterionAverages: emptyAverages(),
    };
  }

  // Cheap key probe BEFORE we burn any tokens. If REQUIRE_BYOK is on
  // and no key is wired (the default test/CI posture), short-circuit
  // to `skipped` so the harness stays free.
  const peek = await peekKeySource(null, 'anthropic');
  if (peek.source === 'missing') {
    return {
      status: 'skipped',
      caseId: args.caseDef.id,
      reason: 'no_anthropic_key',
      modelUsed: null,
      fileScores: [],
      criterionAverages: emptyAverages(),
    };
  }

  const governance: GovernanceScope = {
    user_id: null,
    project_id: null,
    ref: 'evals.judge.' + args.caseDef.id + '.' + args.ref,
  };
  const sample = sampleFilesForJudging(args.caseDef, args.files);
  const goal = caseGoalText(args.caseDef);

  const fileScores: JudgedFileScore[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  for (const f of sample) {
    const userMessage = buildJudgeUserMessage({
      caseDescription: args.caseDef.description,
      caseGoal: goal,
      filePath: f.path,
      fileSource: f.source,
      fileContent: f.content,
    });
    let res;
    try {
      res = await complete({
        model: JUDGE_MODEL,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 600,
        governance: { ...governance, ref: governance.ref + '.' + f.path },
      });
    } catch (err) {
      // If even the FIRST call fails with NeedsKeyError, downgrade
      // to skipped — peek was wrong about key availability.
      if (err instanceof NeedsKeyError) {
        return {
          status: 'skipped',
          caseId: args.caseDef.id,
          reason: 'no_anthropic_key',
          modelUsed: null,
          fileScores: [],
          criterionAverages: emptyAverages(),
        };
      }
      return {
        status: 'failed',
        caseId: args.caseDef.id,
        modelUsed: JUDGE_MODEL,
        error: err instanceof Error ? err.message : 'judge call failed',
        fileScores,
        criterionAverages: averages(fileScores),
      };
    }
    totalInput += res.usage.input_tokens;
    totalOutput += res.usage.output_tokens;
    try {
      const scores = parseJudgeReply(res.text);
      fileScores.push({ path: f.path, scores, rawOnError: null });
    } catch (err) {
      // Parsing failed — we record the raw reply so the user can
      // inspect it. NaN scores propagate as "not scored" in the
      // averages.
      fileScores.push({
        path: f.path,
        scores: JUDGED_CRITERIA.map((c) => ({
          id: c.id,
          score: NaN,
          note: 'parse_error: ' + (err instanceof Error ? err.message : 'unknown'),
        })),
        rawOnError: res.text.slice(0, 500),
      });
    }
  }

  return {
    status: 'completed',
    caseId: args.caseDef.id,
    modelUsed: JUDGE_MODEL,
    fileScores,
    criterionAverages: averages(fileScores),
    usage: { input_tokens: totalInput, output_tokens: totalOutput },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyAverages(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of JUDGED_CRITERIA) out[c.id] = NaN;
  return out;
}

function averages(fileScores: readonly JudgedFileScore[]): Record<string, number> {
  const acc: Record<string, { sum: number; n: number }> = {};
  for (const c of JUDGED_CRITERIA) acc[c.id] = { sum: 0, n: 0 };
  for (const fs of fileScores) {
    for (const s of fs.scores) {
      if (Number.isFinite(s.score)) {
        const slot = acc[s.id];
        if (slot) {
          slot.sum += s.score;
          slot.n += 1;
        }
      }
    }
  }
  const out: Record<string, number> = {};
  for (const c of JUDGED_CRITERIA) {
    const slot = acc[c.id];
    out[c.id] = slot && slot.n > 0 ? slot.sum / slot.n : NaN;
  }
  return out;
}

function caseGoalText(caseDef: GoldenCase): string {
  // Each spec shape carries a goal in a slightly different field;
  // surface a uniform string for the prompt.
  if (caseDef.kind === 'agent') return caseDef.spec.goal;
  if (caseDef.kind === 'system') return caseDef.spec.goal;
  return caseDef.spec.goal;
}
