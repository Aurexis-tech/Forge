// Intake classifier — single LLM call that decides whether a raw prompt
// describes a single AGENT (Phase 1), a multi-agent SYSTEM (Phase 2),
// a small SOFTWARE app (Phase 3), or a piece of INFRASTRUCTURE (Phase
// 4).
//
// Runs on the cheap model (claude-haiku-4-5) so the classification cost
// is negligible relative to the extraction call that follows. Every
// classification goes through lib/engine/llm.complete() so it inherits
// the governance guard + ledger + BYOK key resolution automatically.
//
// The classifier NEVER falls back silently to an arbitrary kind. If the
// model is genuinely uncertain it returns kind='agent' with low
// confidence + a why-string; the caller can show the user an override
// hook ("this is actually a multi-agent system" / "this is actually a
// software app" / "this is actually infrastructure").

import { z } from 'zod';
import { complete, type GovernanceScope, type LLMUsage } from '../llm';
import { CHEAP_LLM_MODEL } from '../governance/pricing';

export const CLASSIFIED_KINDS = ['agent', 'system', 'software', 'infrastructure'] as const;
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

Given a one-paragraph description of an AI product the user wants to build, decide which of FOUR shapes it is: a single AGENT, a multi-agent SYSTEM, a small SOFTWARE app, or a piece of INFRASTRUCTURE.

Return ONLY a single JSON object — no prose before/after, no markdown fences:

{ "kind": "agent" | "system" | "software" | "infrastructure", "confidence": <0..1>, "why": "<short reason, max 1 sentence>" }

DEFINITIONS:
- "agent"          — ONE autonomous worker. Reads inputs, calls some tools, produces an output. Even if it uses several tools (web search + LLM + email), it is still ONE agent. Usually scheduled or triggered, not a UI the user clicks around.
- "system"         — TWO OR MORE coordinated sub-agents with DISTINCT roles, each independently invokable, wired together by a coordination pattern (pipeline / fan_out_in / dag). Examples: "scrape news → summarize → email"; "a researcher agent and a critic agent that debate before answering".
- "software"       — A SMALL WEB APP with pages a user opens, a data model the app stores, and flows that connect them. There's typically auth, a database of entities, and a UI. Examples: "an expenses tracker my team submits to and a manager approves", "a recipe vault I paste URLs into and search later", "a CRM for my freelance work".
- "infrastructure" — DATA OR RUNTIME PLUMBING the user wants stood up: a database, an object store, a queue, a scheduled job that moves data between systems, an HTTP service that hosts something, a worker that consumes a queue. The output is RESOURCES connected by a topology — there is no UI, no specific agent reasoning, and no app the user "uses" interactively. Examples: "a pipeline that ingests events from my sources every hour, stores them, and serves them to my other tools", "a Postgres database with a worker that writes to it and an HTTP API in front", "an object store and a nightly backup cron".

RULES:
- "summarize my emails every morning" → AGENT (single worker, scheduled, no UI, reasoning at the centre).
- "a system that scrapes news, summarizes it, and emails me a briefing" → SYSTEM (decomposes into 3 distinct agent roles).
- "a web app where my team submits and tracks expenses, a manager approves them" → SOFTWARE (pages + entities + roles + flows).
- "a pipeline that ingests events from my sources every hour, stores them, and serves them to my other tools" → INFRASTRUCTURE (resources + topology, no agent reasoning, no UI for end-users).
- If the user describes a UI ("a dashboard where", "a page that lets me", "my team logs in and"), lean SOFTWARE.
- If the user describes a workflow centred on REASONING / DECISIONS ("decides which emails matter", "summarises", "drafts a reply"), lean AGENT (single role) or SYSTEM (multiple roles).
- If the user describes MOVING / STORING / SERVING data with no reasoning step ("ingest", "store", "serve", "queue", "back up", "host"), lean INFRASTRUCTURE.
- If the user uses the word "system" loosely for a single workflow, look at the actual decomposition — not the literal word. Same for "pipeline" — a pipeline of REASONING is a SYSTEM; a pipeline of DATA MOVEMENT is INFRASTRUCTURE.
- Be honest about confidence: 0.9+ only when the answer is unambiguous; 0.5-0.7 when it could reasonably go either way; lower if you genuinely cannot tell.
- "why" is a SHORT reason (one clause), e.g. "resources + topology + no reasoning = infrastructure".

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
