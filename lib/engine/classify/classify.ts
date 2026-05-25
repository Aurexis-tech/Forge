// Intake classifier — single LLM call that decides whether a raw prompt
// describes a single AGENT (Phase 1) or a multi-agent SYSTEM (Phase 2).
//
// Runs on the cheap model (claude-haiku-4-5) so the classification cost
// is negligible relative to the extraction call that follows. Every
// classification goes through lib/engine/llm.complete() so it inherits
// the governance guard + ledger + BYOK key resolution automatically.
//
// The classifier NEVER falls back silently to an arbitrary kind. If the
// model is genuinely uncertain it returns kind='agent' with low
// confidence + a why-string; the caller can show the user an override
// hook ("this is actually a multi-agent system").

import { z } from 'zod';
import { complete, type GovernanceScope, type LLMUsage } from '../llm';
import { CHEAP_LLM_MODEL } from '../governance/pricing';

export const CLASSIFIED_KINDS = ['agent', 'system'] as const;
export type ClassifiedKind = (typeof CLASSIFIED_KINDS)[number];

// What the classifier hands back. The caller threads `kind` straight
// into the right extractor; `confidence` + `why` are surfaced into the
// audit log + (optionally) the UI so the user can override.
export interface ClassificationResult {
  kind: ClassifiedKind;
  confidence: number;
  why: string;
  model: string;
  usage: LLMUsage;
}

const ClassificationJsonSchema = z.object({
  kind: z.enum(CLASSIFIED_KINDS),
  confidence: z.number().min(0).max(1),
  why: z.string().trim().min(1).max(280),
});

const SYSTEM_PROMPT =
  `You are the Aurexis Forge intake classifier.

Given a one-paragraph description of an AI product the user wants to build, decide whether it should be implemented as a single AGENT or a multi-agent SYSTEM.

Return ONLY a single JSON object — no prose before/after, no markdown fences:

{ "kind": "agent" | "system", "confidence": <0..1>, "why": "<short reason, max 1 sentence>" }

DEFINITIONS:
- "agent" — ONE autonomous worker. Reads inputs, calls some tools, produces an output. Even if it uses several tools (web search + LLM + email), it is still ONE agent.
- "system" — TWO OR MORE coordinated sub-agents with DISTINCT roles, each one independently invokable in principle, wired together by a coordination pattern (pipeline / fan_out_in / dag). Examples that are systems: "scrape news → summarize → email"; "a researcher agent and a critic agent that debate before answering"; "a triage bot that dispatches to specialized solvers and aggregates their answers".

RULES:
- A request like "summarize my emails every morning" is an AGENT (single worker, scheduled).
- A request like "a system that scrapes news, summarizes it, and emails me a briefing" is a SYSTEM (clear decomposition into 3 distinct roles).
- If the user uses the word "system" loosely for a single workflow, look at the actual decomposition — not the literal word.
- Be honest about confidence: 0.9+ only when the answer is unambiguous; 0.5-0.7 when it could reasonably go either way; lower if you genuinely cannot tell.
- "why" is a SHORT reason (one clause), e.g. "scrape→summarize→email decomposes into 3 distinct roles".

Output JSON only.`;

const USER_TEMPLATE = (raw: string) => 'PROMPT:\n' + raw.trim();

export async function classifyIntake(args: {
  rawPrompt: string;
  governance: GovernanceScope;
}): Promise<ClassificationResult> {
  const res = await complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: USER_TEMPLATE(args.rawPrompt) }],
    model: CHEAP_LLM_MODEL,
    maxTokens: 200,
    governance: {
      ...args.governance,
      ref: (args.governance.ref ?? 'intake.classify') + '.classify',
    },
  });

  const parsed = tryParse(res.text);
  // Fail-soft: if the classifier itself can't be parsed, default to
  // 'agent' (the safe path — preserves Phase 1 behaviour) with very low
  // confidence so the audit log shows what happened. The classifier
  // failing is rare and ALWAYS recoverable by the user overriding the
  // kind on retry.
  if (!parsed.ok) {
    return {
      kind: 'agent',
      confidence: 0,
      why: 'classifier output unparseable — defaulted to agent (' + parsed.error + ')',
      model: res.model,
      usage: res.usage,
    };
  }
  return {
    kind: parsed.data.kind,
    confidence: parsed.data.confidence,
    why: parsed.data.why,
    model: res.model,
    usage: res.usage,
  };
}

// A classification is "ambiguous" when the confidence is below this
// threshold. Callers may choose to surface an override prompt in the UI
// when this is true; the route itself still proceeds with the picked
// kind so the user always sees a draft.
export const AMBIGUOUS_CONFIDENCE_THRESHOLD = 0.6;

export function isAmbiguous(c: ClassificationResult): boolean {
  return c.confidence < AMBIGUOUS_CONFIDENCE_THRESHOLD;
}

interface ParseOk {
  ok: true;
  data: { kind: ClassifiedKind; confidence: number; why: string };
}
interface ParseErr {
  ok: false;
  error: string;
}

function tryParse(text: string): ParseOk | ParseErr {
  const cleaned = stripFences(text).trim();
  const sliced = sliceToOuterJsonObject(cleaned);
  if (!sliced) return { ok: false, error: 'no JSON object found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' };
  }
  const validated = ClassificationJsonSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      error: validated.error.issues
        .slice(0, 3)
        .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
        .join('; '),
    };
  }
  return { ok: true, data: validated.data };
}

function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) {
    return t
      .replace(/^```(?:json|JSON)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
  }
  return t;
}

function sliceToOuterJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
