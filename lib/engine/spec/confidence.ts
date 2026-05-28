// CONFIDENCE-MARKED SPEC — per-field labels indicating WHERE each
// value came from (the user, an inference, a default, or absence).
//
// ENGINE-OWNED. Additive on top of extraction: the Zod schemas are
// unchanged, the spec shape persisted in `specs.structured_spec`
// is unchanged. Confidence is a SEPARATE optional metadata blob
// (lives in the new `specs.confidence_json` column added by
// migration 0028) consumed by the clarification loop, the
// uncertainty detector, and (next prompt) the show-spec gate UI.
//
// COMPUTATION IS DETERMINISTIC — no LLM. The model produces the
// spec; we classify each top-level field by comparing its value to
// the intent text, the schema defaults, and a small set of mold-
// specific shape rules. This keeps the loop cheap (no extra LLM
// call to grade each spec) AND reliable (the model can't bluff its
// own confidence map).
//
// Dependency direction: engine owns this. evals can REFERENCE it
// (drift-guarded if it ever scores against confidence ids); never
// the reverse.

import type { AgentSpec } from './schema';
import type { SystemSpec } from '../system/spec';
import type { SoftwareSpec } from '../software/spec';
import type { InfraSpec } from '../infra/spec';
import type { SpecMold } from './quality';

export const CONFIDENCE_LEVELS = [
  'stated',
  'inferred',
  'guessed',
  'missing',
] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/**
 * Per-top-level-field confidence map. Keys are spec field names
 * (e.g. 'goal', 'trigger', 'sub_agents', 'entities', 'resources').
 * Missing keys = field not classified; consumers should treat as
 * 'missing' (no information).
 */
export type SpecConfidence = Readonly<Record<string, ConfidenceLevel>>;

// ---------------------------------------------------------------------------
// Tokenisation helpers (deterministic).
// ---------------------------------------------------------------------------

/** Lower-case + strip punctuation. Splitting on whitespace gives us a
 *  bag of words we can intersect against spec field values. */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const t of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length >= 3) out.add(t);
  }
  return out;
}

/**
 * Returns true if any "significant" word from `value` (length>=3,
 * not a stopword) appears in `intentTokens`. Used as the cheap
 * "did the user say this?" probe.
 */
function valueMentionedInIntent(value: string, intentTokens: ReadonlySet<string>): boolean {
  const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into',
    'about', 'will', 'should', 'have', 'each', 'when', 'then',
    'they', 'them', 'are', 'was', 'were', 'one', 'two', 'app',
    'system', 'spec', 'data', 'user', 'users', 'new', 'old',
  ]);
  for (const t of tokens(value)) {
    if (STOPWORDS.has(t)) continue;
    if (intentTokens.has(t)) return true;
  }
  return false;
}

/** Classify a single STRING field. */
function classifyString(
  value: string | undefined,
  intentTokens: ReadonlySet<string>,
  options: { defaultSentinel?: ReadonlyArray<string> } = {},
): ConfidenceLevel {
  if (!value || value.trim().length === 0) return 'missing';
  const trimmed = value.trim().toLowerCase();
  for (const sentinel of options.defaultSentinel ?? []) {
    if (trimmed === sentinel.toLowerCase()) return 'guessed';
  }
  if (valueMentionedInIntent(value, intentTokens)) return 'stated';
  return 'inferred';
}

/** Classify an ENUM field whose semantic anchor lives in the intent. */
function classifyEnum<T extends string>(
  value: T | undefined,
  intentTokens: ReadonlySet<string>,
  options: {
    /** Per-enum-value: tokens whose presence in intent implies this enum was 'stated'. */
    anchors: Record<T, ReadonlyArray<string>>;
    /** The schema default value — when chosen and unstated, classified 'guessed'. */
    schemaDefault?: T;
  },
): ConfidenceLevel {
  if (!value) return 'missing';
  const anchorWords = options.anchors[value] ?? [];
  for (const word of anchorWords) {
    if (intentTokens.has(word.toLowerCase())) return 'stated';
  }
  if (options.schemaDefault === value) return 'guessed';
  return 'inferred';
}

/** Classify a BOOLEAN by anchor tokens in the intent. */
function classifyBoolean(
  value: boolean | undefined,
  intentTokens: ReadonlySet<string>,
  options: {
    trueAnchors?: ReadonlyArray<string>;
    falseAnchors?: ReadonlyArray<string>;
    schemaDefault?: boolean;
  },
): ConfidenceLevel {
  if (value === undefined) return 'missing';
  const anchors = value ? options.trueAnchors ?? [] : options.falseAnchors ?? [];
  for (const word of anchors) {
    if (intentTokens.has(word.toLowerCase())) return 'stated';
  }
  if (options.schemaDefault === value) return 'guessed';
  return 'inferred';
}

/** Classify an ARRAY field. 'missing' when empty; 'stated' when any
 *  element mentions an intent token; 'inferred' otherwise. */
function classifyArray<T>(
  values: ReadonlyArray<T> | undefined,
  intentTokens: ReadonlySet<string>,
  extractText: (v: T) => string,
): ConfidenceLevel {
  if (!values || values.length === 0) return 'missing';
  for (const v of values) {
    if (valueMentionedInIntent(extractText(v), intentTokens)) return 'stated';
  }
  return 'inferred';
}

// ---------------------------------------------------------------------------
// Per-mold compute functions. Each returns a confidence label per
// top-level required field.
// ---------------------------------------------------------------------------

export function computeAgentConfidence(
  spec: AgentSpec,
  intent: string,
): SpecConfidence {
  const tk = tokens(intent);
  const triggerAnchors: Record<AgentSpec['trigger'], ReadonlyArray<string>> = {
    schedule: ['every', 'daily', 'weekly', 'morning', 'cron', 'hourly', 'nightly'],
    webhook: ['when', 'whenever', 'webhook', 'event', 'push'],
    api: ['endpoint', 'api', 'call'],
    chat: ['chat', 'ask', 'reply', 'conversation'],
  };
  const runtimeAnchors: Record<AgentSpec['runtime'], ReadonlyArray<string>> = {
    always_on: ['always', 'continuously', 'live', 'realtime'],
    on_demand: ['ondemand', 'demand', 'invocation'],
  };
  return {
    name: classifyString(spec.name, tk),
    goal: classifyString(spec.goal, tk),
    description: classifyString(spec.description, tk),
    trigger: classifyEnum(spec.trigger, tk, {
      anchors: triggerAnchors,
      schemaDefault: 'chat',
    }),
    runtime: classifyEnum(spec.runtime, tk, {
      anchors: runtimeAnchors,
      schemaDefault: 'on_demand',
    }),
    inputs: classifyArray(spec.inputs, tk, (i) => i.name + ' ' + i.description),
    capabilities: classifyArray(spec.capabilities, tk, (c) => c.tool + ' ' + c.why),
    outputs: classifyArray(spec.outputs, tk, (o) => o.name + ' ' + o.description),
    constraints: classifyArray(spec.constraints, tk, (s) => s),
    success_criteria: classifyArray(spec.success_criteria, tk, (s) => s),
    risk: classifyString(spec.risk, tk, { defaultSentinel: ['low'] }),
  };
}

export function computeSystemConfidence(
  spec: SystemSpec,
  intent: string,
): SpecConfidence {
  const tk = tokens(intent);
  const patternAnchors: Record<
    SystemSpec['coordination']['pattern'],
    ReadonlyArray<string>
  > = {
    pipeline: ['pipeline', 'sequential', 'step', 'chain', 'after'],
    fan_out_in: ['parallel', 'fan', 'aggregate', 'combine', 'concurrent'],
    dag: ['dag', 'graph', 'depends'],
  };
  return {
    goal: classifyString(spec.goal, tk),
    sub_agents: classifyArray(spec.sub_agents, tk, (a) => a.role + ' ' + a.description),
    coordination_pattern: classifyEnum(spec.coordination.pattern, tk, {
      anchors: patternAnchors,
      // No real schema default for pattern — pipeline is the typical
      // implicit choice but mol-d-required to be explicit.
      schemaDefault: 'pipeline',
    }),
    triggers: classifyArray(spec.triggers, tk, (t) => t),
    // max_steps: the schema default is 25 (DEFAULT_MAX_STEPS); anything
    // else is inferred. There's no way to "state" a number tactically
    // by token-match, so a non-default value implies engineering.
    max_steps:
      spec.max_steps === 25
        ? 'guessed'
        : spec.max_steps > 0
          ? 'inferred'
          : 'missing',
  };
}

export function computeSoftwareConfidence(
  spec: SoftwareSpec,
  intent: string,
): SpecConfidence {
  const tk = tokens(intent);
  return {
    goal: classifyString(spec.goal, tk),
    pages: classifyArray(spec.pages, tk, (p) => p.id + ' ' + p.name + ' ' + p.purpose),
    entities: classifyArray(spec.entities, tk, (e) =>
      e.name + ' ' + e.fields.map((f) => f.name).join(' '),
    ),
    flows: classifyArray(spec.flows, tk, (f) => f.name + ' ' + f.description),
    auth_requires_auth: classifyBoolean(spec.auth.requires_auth, tk, {
      trueAnchors: ['login', 'auth', 'signin', 'sign-in', 'account', 'users'],
      falseAnchors: ['public', 'anonymous', 'noauth'],
      // No schema default — but per-mold addendum demands an explicit boolean.
    }),
    auth_per_user_isolation: classifyBoolean(spec.auth.per_user_isolation, tk, {
      trueAnchors: ['own', 'isolation', 'private', 'mine', 'only see their'],
      falseAnchors: ['shared', 'all-users', 'team-wide'],
    }),
  };
}

export function computeInfraConfidence(
  spec: InfraSpec,
  intent: string,
): SpecConfidence {
  const tk = tokens(intent);
  const lifecycleAnchors: Record<
    InfraSpec['lifecycle'],
    ReadonlyArray<string>
  > = {
    ephemeral: ['ephemeral', 'preview', 'temporary', 'throwaway', 'sandbox'],
    persistent: ['persistent', 'production', 'keep', 'durable', 'long-lived'],
  };
  return {
    goal: classifyString(spec.goal, tk),
    resources: classifyArray(spec.resources, tk, (r) => r.id + ' ' + r.type),
    topology: classifyArray(spec.topology, tk, (e) => e.from + ' ' + e.to),
    lifecycle: classifyEnum(spec.lifecycle, tk, {
      anchors: lifecycleAnchors,
      schemaDefault: 'persistent',
    }),
    region:
      spec.region === undefined
        ? 'missing'
        : valueMentionedInIntent(spec.region, tk)
          ? 'stated'
          : 'inferred',
  };
}

// ---------------------------------------------------------------------------
// Dispatch by mold.
// ---------------------------------------------------------------------------
export function computeConfidence(
  mold: SpecMold,
  spec: unknown,
  intent: string,
): SpecConfidence {
  switch (mold) {
    case 'agent':
      return computeAgentConfidence(spec as AgentSpec, intent);
    case 'system':
      return computeSystemConfidence(spec as SystemSpec, intent);
    case 'software':
      return computeSoftwareConfidence(spec as SoftwareSpec, intent);
    case 'infrastructure':
      return computeInfraConfidence(spec as InfraSpec, intent);
  }
}

// ---------------------------------------------------------------------------
// Per-mold field catalogs — used by the uncertainty detector to know
// which fields are required to even be considered (and by the
// drift-guard infra in evals to assert the rubric talks about a real
// field). Exposed as a public helper so consumers don't duplicate
// the field list.
// ---------------------------------------------------------------------------
export const MOLD_REQUIRED_FIELDS: Record<SpecMold, ReadonlyArray<string>> = {
  agent: [
    'name',
    'goal',
    'description',
    'trigger',
    'runtime',
    'inputs',
    'capabilities',
    'outputs',
    'constraints',
    'success_criteria',
    'risk',
  ],
  system: [
    'goal',
    'sub_agents',
    'coordination_pattern',
    'triggers',
    'max_steps',
  ],
  software: [
    'goal',
    'pages',
    'entities',
    'flows',
    'auth_requires_auth',
    'auth_per_user_isolation',
  ],
  infrastructure: ['goal', 'resources', 'topology', 'lifecycle', 'region'],
};
