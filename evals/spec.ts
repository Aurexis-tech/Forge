// Spec-fidelity tier — measures how well the per-mold extractor turns
// a user's natural-language INTENT into a precise, actionable spec
// that satisfies the engine's SPEC_QUALITY_BAR.
//
// Mirror of evals/structural.ts + evals/judge.ts but for extracted
// specs:
//
//   - STRUCTURAL — placeholders / required-field-filled / named-
//     catalog-entries / Zod-parses / mold matches expected.
//     Deterministic, no LLM, ALWAYS runs.
//
//   - JUDGED — Haiku-tier LLM scores the produced spec against the
//     bar's judged criteria. Same key-gating as the codegen judged
//     tier: `peekKeySource` first, self-skip with reason
//     'no_anthropic_key' when no key is wired. Cost-flagged in the
//     report.
//
// Reuses the codegen judged tier's `complete()` seam unchanged — same
// governance, same ledger, same model resolution.
//
// Dependency direction: this file imports from the engine + golden
// cases. Engine never imports from here.

import { complete, type GovernanceScope } from '@/lib/engine/llm';
import { NeedsKeyError, peekKeySource } from '@/lib/engine/keys';
import {
  SPEC_QUALITY_BAR,
  type SpecMold,
} from '@/lib/engine/spec/quality';
import { AGENT_SPEC_ADDENDUM } from '@/lib/engine/spec/quality';
import { SYSTEM_SPEC_ADDENDUM } from '@/lib/engine/system/spec-quality';
import { SOFTWARE_SPEC_ADDENDUM } from '@/lib/engine/software/spec-quality';
import { INFRA_SPEC_ADDENDUM } from '@/lib/engine/infra/spec-quality';
import { AgentSpecSchema } from '@/lib/engine/spec/schema';
import { SystemSpecSchema } from '@/lib/engine/system/spec';
import { SoftwareSpecSchema } from '@/lib/engine/software/spec';
import { InfraSpecSchema } from '@/lib/engine/infra/spec';
import type { GoldenCase } from './golden';
import {
  SPEC_JUDGE_MODEL,
  SPEC_JUDGE_FILE_MAX_CHARS,
} from './spec-judge-constants';

// ---------------------------------------------------------------------------
// PUBLIC RESULT SHAPES
// ---------------------------------------------------------------------------
export interface SpecStructuralCriterionResult {
  id: string;
  label: string;
  ok: boolean;
  failures: string[];
}

export interface SpecStructuralReport {
  caseId: string;
  specBarVersion: string;
  criteria: SpecStructuralCriterionResult[];
  passedCount: number;
  totalCount: number;
  allOk: boolean;
}

export interface SpecJudgedCriterionScore {
  id: string;
  score: number;
  note: string;
}

export type SpecJudgedReport =
  | {
      status: 'skipped';
      caseId: string;
      reason: 'no_anthropic_key' | 'disabled' | 'extraction_skipped';
      modelUsed: null;
      scores: never[];
      criterionAverages: Record<string, number>;
    }
  | {
      status: 'completed';
      caseId: string;
      modelUsed: string;
      scores: SpecJudgedCriterionScore[];
      criterionAverages: Record<string, number>;
      usage: { input_tokens: number; output_tokens: number };
    }
  | {
      status: 'failed';
      caseId: string;
      modelUsed: string;
      error: string;
      scores: SpecJudgedCriterionScore[];
      criterionAverages: Record<string, number>;
    };

// ---------------------------------------------------------------------------
// STRUCTURAL SCORER
// ---------------------------------------------------------------------------
//
// Five criteria — checked deterministically:
//   1. schema_parses         — produced spec parses against its Zod schema
//   2. mold_matches_expected — extractor returned the expected mold's shape
//   3. no_placeholder_values — no "TBD", "various", "any", etc. in required fields
//   4. named_catalog_entries — capabilities/coordination/resources from catalog
//   5. required_fields_filled — every schema-required field has real content

const PLACEHOLDER_RE = /\b(TBD|tbd|placeholder|various|to be determined|undecided|n\/a|N\/A)\b/;

export interface ScoreSpecStructuralArgs {
  caseDef: GoldenCase;
  /** The spec the extractor produced for this case. */
  producedSpec: unknown;
  /** Mold the extractor was told to use (driven by the case kind). */
  producedMold: SpecMold;
  specBarVersion: string;
}

export function scoreSpecStructural(
  args: ScoreSpecStructuralArgs,
): SpecStructuralReport {
  const { caseDef, producedSpec, producedMold, specBarVersion } = args;
  const expectedMold = caseDef.kind === 'infrastructure' ? 'infrastructure' : caseDef.kind;

  // 1. Schema parse — pick the schema by produced mold.
  const parseResult = parseSpecAgainstSchema(producedMold, producedSpec);
  const schemaOk = parseResult.ok;
  const schemaFailures = schemaOk ? [] : [parseResult.error];

  // 2. Mold match.
  const moldOk = producedMold === expectedMold;
  const moldFailures = moldOk
    ? []
    : [
        'extractor produced mold ' +
          producedMold +
          ', expected ' +
          expectedMold,
      ];

  // 3. Placeholder scan over the serialised spec.
  const serialised = JSON.stringify(producedSpec ?? null);
  const placeholderHit = PLACEHOLDER_RE.exec(serialised);
  const placeholderOk = placeholderHit === null;
  const placeholderFailures = placeholderOk
    ? []
    : [
        'placeholder value detected: "' +
          (placeholderHit ? placeholderHit[0] : '?') +
          '"',
      ];

  // 4. Named catalog entries — per-mold scanning.
  const catalogFailures = scanCatalogGrounding(producedMold, producedSpec);
  const catalogOk = catalogFailures.length === 0;

  // 5. Required fields filled — only checks the fields the Zod schema
  //    marks REQUIRED at root level. Empty strings + empty arrays
  //    where the schema demands content count as "unfilled".
  const requiredFailures = scanRequiredFields(producedMold, producedSpec);
  const requiredOk = requiredFailures.length === 0;

  const cap = (arr: string[]): string[] => arr.slice(0, 5);
  const criteria: SpecStructuralCriterionResult[] = [
    {
      id: 'schema_parses',
      label: 'Spec parses against its Zod schema',
      ok: schemaOk,
      failures: cap(schemaFailures),
    },
    {
      id: 'mold_matches_expected',
      label: 'Mold matches the expected one',
      ok: moldOk,
      failures: cap(moldFailures),
    },
    {
      id: 'no_placeholder_values',
      label: 'No placeholder / vague fillers',
      ok: placeholderOk,
      failures: cap(placeholderFailures),
    },
    {
      id: 'named_catalog_entries',
      label: 'Named catalog entries used where required',
      ok: catalogOk,
      failures: cap(catalogFailures),
    },
    {
      id: 'required_fields_filled',
      label: 'Required fields filled with real content',
      ok: requiredOk,
      failures: cap(requiredFailures),
    },
  ];

  const passedCount = criteria.filter((c) => c.ok).length;
  return {
    caseId: caseDef.id,
    specBarVersion,
    criteria,
    passedCount,
    totalCount: criteria.length,
    allOk: passedCount === criteria.length,
  };
}

function parseSpecAgainstSchema(
  mold: SpecMold,
  spec: unknown,
): { ok: true } | { ok: false; error: string } {
  const schema =
    mold === 'agent'
      ? AgentSpecSchema
      : mold === 'system'
        ? SystemSpecSchema
        : mold === 'software'
          ? SoftwareSpecSchema
          : InfraSpecSchema;
  const r = schema.safeParse(spec);
  if (r.success) return { ok: true };
  const issues = r.error.issues
    .slice(0, 4)
    .map(
      (i) =>
        (i.path.length === 0 ? '(root)' : i.path.join('.')) +
        ': ' +
        i.message,
    )
    .join('; ');
  return { ok: false, error: issues };
}

function scanCatalogGrounding(mold: SpecMold, spec: unknown): string[] {
  const issues: string[] = [];
  if (!spec || typeof spec !== 'object') return issues;
  const s = spec as Record<string, unknown>;
  if (mold === 'agent') {
    const caps = (s.capabilities as unknown[]) ?? [];
    for (const c of caps) {
      if (!c || typeof c !== 'object') continue;
      const tool = (c as { tool?: unknown }).tool;
      if (typeof tool !== 'string') {
        issues.push('capability has non-string tool');
        continue;
      }
      // We don't import the registry to avoid the structural scorer
      // dragging in the planner; the prompt should pin tools to the
      // registry — the judged tier covers semantic correctness here.
      // Structurally we only check shape (lower_snake_case).
      if (!/^[a-z][a-z0-9_]*$/.test(tool)) {
        issues.push("capability tool '" + tool + "' is not lower_snake_case");
      }
    }
  }
  if (mold === 'system') {
    const coord = s.coordination as
      | { pattern?: unknown; edges?: unknown }
      | undefined;
    const pattern = coord?.pattern;
    if (pattern !== 'pipeline' && pattern !== 'fan_out_in' && pattern !== 'dag') {
      issues.push(
        "coordination.pattern '" +
          String(pattern) +
          "' not in catalog (pipeline | fan_out_in | dag)",
      );
    }
  }
  if (mold === 'software') {
    const ents = (s.entities as unknown[]) ?? [];
    const allowed = new Set([
      'string',
      'text',
      'number',
      'boolean',
      'date',
      'datetime',
      'email',
      'url',
      'enum',
      'reference',
    ]);
    for (const e of ents) {
      if (!e || typeof e !== 'object') continue;
      const fields = (e as { fields?: unknown }).fields;
      if (!Array.isArray(fields)) continue;
      for (const f of fields) {
        if (!f || typeof f !== 'object') continue;
        const t = (f as { type?: unknown }).type;
        if (typeof t !== 'string' || !allowed.has(t)) {
          issues.push("entity field type '" + String(t) + "' not in FIELD_TYPES catalog");
        }
      }
    }
  }
  if (mold === 'infrastructure') {
    const resources = (s.resources as unknown[]) ?? [];
    const allowed = new Set([
      'postgres_db',
      'object_store',
      'queue',
      'worker',
      'cron',
      'http_service',
    ]);
    for (const r of resources) {
      if (!r || typeof r !== 'object') continue;
      const t = (r as { type?: unknown }).type;
      if (typeof t !== 'string' || !allowed.has(t)) {
        issues.push("resource type '" + String(t) + "' not in RESOURCE_TYPES catalog");
      }
    }
    const lifecycle = s.lifecycle;
    if (lifecycle !== 'ephemeral' && lifecycle !== 'persistent') {
      issues.push(
        "lifecycle '" + String(lifecycle) + "' not in {ephemeral, persistent}",
      );
    }
  }
  return issues;
}

function scanRequiredFields(mold: SpecMold, spec: unknown): string[] {
  const issues: string[] = [];
  if (!spec || typeof spec !== 'object') {
    issues.push('spec is not an object');
    return issues;
  }
  const s = spec as Record<string, unknown>;
  const goal = s.goal;
  if (typeof goal !== 'string' || goal.trim().length === 0) {
    issues.push('goal: missing or empty');
  }
  if (mold === 'agent') {
    if (typeof s.name !== 'string' || (s.name as string).trim().length === 0) {
      issues.push('name: missing or empty');
    }
    if (typeof s.trigger !== 'string') issues.push('trigger: missing');
    if (typeof s.runtime !== 'string') issues.push('runtime: missing');
  }
  if (mold === 'system') {
    const subs = s.sub_agents;
    if (!Array.isArray(subs) || subs.length < 2) {
      issues.push('sub_agents: must have at least 2 entries');
    }
  }
  if (mold === 'software') {
    const pages = s.pages;
    const entities = s.entities;
    if (!Array.isArray(pages) || pages.length === 0) {
      issues.push('pages: must have at least 1 entry');
    }
    if (!Array.isArray(entities) || entities.length === 0) {
      issues.push('entities: must have at least 1 entry');
    }
    const auth = s.auth as { requires_auth?: unknown; per_user_isolation?: unknown } | undefined;
    if (!auth || typeof auth.requires_auth !== 'boolean' || typeof auth.per_user_isolation !== 'boolean') {
      issues.push('auth: requires_auth + per_user_isolation must be explicit booleans');
    }
  }
  if (mold === 'infrastructure') {
    const resources = s.resources;
    if (!Array.isArray(resources) || resources.length === 0) {
      issues.push('resources: must have at least 1 entry');
    }
    if (s.lifecycle !== 'ephemeral' && s.lifecycle !== 'persistent') {
      issues.push('lifecycle: must be ephemeral or persistent');
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// JUDGED SCORER — LLM-as-judge over the produced spec.
// ---------------------------------------------------------------------------

// Render the bar for the judge prompt — same set the extractor saw.
function moldQualityBullets(mold: SpecMold): string {
  const addendum =
    mold === 'agent'
      ? AGENT_SPEC_ADDENDUM
      : mold === 'system'
        ? SYSTEM_SPEC_ADDENDUM
        : mold === 'software'
          ? SOFTWARE_SPEC_ADDENDUM
          : INFRA_SPEC_ADDENDUM;
  return [...SPEC_QUALITY_BAR, ...addendum]
    .map((c, i) => '  ' + (i + 1) + '. ' + c.id + ' :: ' + c.label + ' — ' + c.imperative)
    .join('\n');
}

const SPEC_JUDGE_SYSTEM_PROMPT =
  'You are a spec-quality judge for an automated extraction system. You will be given a USER INTENT plus a PRODUCED SPEC (JSON) and a RUBRIC of criteria. Score each criterion 1 (worst) to 5 (best). Be calibrated: 3 means "average extraction"; 5 is reserved for a spec that fully captures the intent against the bar; 1 means the criterion is plainly violated.\n\n' +
  'Reply with a SINGLE JSON object: { "scores": [ { "id": "<criterion id>", "score": <1-5>, "note": "<<=120 chars>" } ] }. No prose outside the JSON. No code fences. Include exactly one entry per rubric id.';

function buildJudgeUserMessage(args: {
  mold: SpecMold;
  intent: string;
  producedSpec: unknown;
}): string {
  const ser = JSON.stringify(args.producedSpec ?? null, null, 2);
  const truncated =
    ser.length <= SPEC_JUDGE_FILE_MAX_CHARS
      ? ser
      : ser.slice(0, Math.floor((SPEC_JUDGE_FILE_MAX_CHARS * 2) / 3)) +
        '\n... [elided] ...\n' +
        ser.slice(-Math.floor(SPEC_JUDGE_FILE_MAX_CHARS / 3));
  return (
    'MOLD: ' +
    args.mold +
    '\nINTENT:\n' +
    args.intent +
    '\n\nPRODUCED SPEC:\n' +
    truncated +
    '\n\nRUBRIC (every entry is base + ' +
    args.mold +
    ' addendum):\n' +
    moldQualityBullets(args.mold) +
    '\n\nReturn ONLY the JSON object described in the system prompt.'
  );
}

function extractJudgeJson(text: string): unknown {
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
  throw new Error('judge did not return JSON');
}

function parseJudgeReply(
  text: string,
  rubricIds: readonly string[],
): SpecJudgedCriterionScore[] {
  const parsed = extractJudgeJson(text);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { scores?: unknown }).scores)
  ) {
    throw new Error('judge reply did not contain a scores array');
  }
  const raw = (parsed as { scores: unknown[] }).scores;
  const byId = new Map<string, SpecJudgedCriterionScore>();
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
    const note = typeof e.note === 'string' ? e.note.slice(0, 200) : '';
    byId.set(id, { id, score, note });
  }
  return rubricIds.map(
    (id): SpecJudgedCriterionScore =>
      byId.get(id) ?? { id, score: NaN, note: '(no score returned)' },
  );
}

export interface ScoreSpecJudgedArgs {
  caseDef: GoldenCase;
  producedSpec: unknown;
  producedMold: SpecMold;
  ref: string;
  enabled: boolean;
}

export async function scoreSpecJudged(
  args: ScoreSpecJudgedArgs,
): Promise<SpecJudgedReport> {
  if (!args.enabled) {
    return {
      status: 'skipped',
      caseId: args.caseDef.id,
      reason: 'disabled',
      modelUsed: null,
      scores: [],
      criterionAverages: emptyAverages(args.producedMold),
    };
  }
  const peek = await peekKeySource(null, 'anthropic');
  if (peek.source === 'missing') {
    return {
      status: 'skipped',
      caseId: args.caseDef.id,
      reason: 'no_anthropic_key',
      modelUsed: null,
      scores: [],
      criterionAverages: emptyAverages(args.producedMold),
    };
  }

  const rubricIds = collectMoldIds(args.producedMold);
  const governance: GovernanceScope = {
    user_id: null,
    project_id: null,
    ref: 'evals.spec-judge.' + args.caseDef.id + '.' + args.ref,
  };

  let res;
  try {
    res = await complete({
      model: SPEC_JUDGE_MODEL,
      system: SPEC_JUDGE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildJudgeUserMessage({
            mold: args.producedMold,
            intent: args.caseDef.intent,
            producedSpec: args.producedSpec,
          }),
        },
      ],
      maxTokens: 800,
      governance,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      return {
        status: 'skipped',
        caseId: args.caseDef.id,
        reason: 'no_anthropic_key',
        modelUsed: null,
        scores: [],
        criterionAverages: emptyAverages(args.producedMold),
      };
    }
    return {
      status: 'failed',
      caseId: args.caseDef.id,
      modelUsed: SPEC_JUDGE_MODEL,
      error: err instanceof Error ? err.message : 'judge call failed',
      scores: [],
      criterionAverages: emptyAverages(args.producedMold),
    };
  }

  let scores: SpecJudgedCriterionScore[];
  try {
    scores = parseJudgeReply(res.text, rubricIds);
  } catch (err) {
    return {
      status: 'failed',
      caseId: args.caseDef.id,
      modelUsed: SPEC_JUDGE_MODEL,
      error: 'parse_error: ' + (err instanceof Error ? err.message : 'unknown'),
      scores: rubricIds.map((id) => ({ id, score: NaN, note: '(parse failed)' })),
      criterionAverages: emptyAverages(args.producedMold),
    };
  }

  const acc: Record<string, { sum: number; n: number }> = {};
  for (const id of rubricIds) acc[id] = { sum: 0, n: 0 };
  for (const s of scores) {
    if (Number.isFinite(s.score)) {
      const slot = acc[s.id];
      if (slot) {
        slot.sum += s.score;
        slot.n += 1;
      }
    }
  }
  const criterionAverages: Record<string, number> = {};
  for (const id of rubricIds) {
    const slot = acc[id];
    criterionAverages[id] = slot && slot.n > 0 ? slot.sum / slot.n : NaN;
  }

  return {
    status: 'completed',
    caseId: args.caseDef.id,
    modelUsed: SPEC_JUDGE_MODEL,
    scores,
    criterionAverages,
    usage: {
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
    },
  };
}

function emptyAverages(mold: SpecMold): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of collectMoldIds(mold)) out[id] = NaN;
  return out;
}

export function collectMoldIds(mold: SpecMold): string[] {
  const addendum =
    mold === 'agent'
      ? AGENT_SPEC_ADDENDUM
      : mold === 'system'
        ? SYSTEM_SPEC_ADDENDUM
        : mold === 'software'
          ? SOFTWARE_SPEC_ADDENDUM
          : INFRA_SPEC_ADDENDUM;
  return [...SPEC_QUALITY_BAR.map((c) => c.id), ...addendum.map((c) => c.id)];
}
