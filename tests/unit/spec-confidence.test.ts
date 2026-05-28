// Hermetic unit test — per-mold spec CONFIDENCE compute.
//
// Tests the deterministic confidence classifier directly: given a
// (spec, intent) pair, every top-level required field of that mold
// must be labelled with a confidence level. No LLM, no network.

import { describe, expect, it } from 'vitest';
import {
  computeAgentConfidence,
  computeConfidence,
  computeInfraConfidence,
  computeSoftwareConfidence,
  computeSystemConfidence,
  CONFIDENCE_LEVELS,
  MOLD_REQUIRED_FIELDS,
  type ConfidenceLevel,
} from '@/lib/engine/spec/confidence';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { SystemSpecSchema, type SystemSpec } from '@/lib/engine/system/spec';
import {
  SoftwareSpecSchema,
  type SoftwareSpec,
} from '@/lib/engine/software/spec';
import { InfraSpecSchema, type InfraSpec } from '@/lib/engine/infra/spec';

// ---------------------------------------------------------------------------
// AGENT
// ---------------------------------------------------------------------------
describe('computeAgentConfidence', () => {
  const intent =
    'Every morning at 9am, fetch a URL I configure, compare the page content to yesterday\'s, and email me a short brief describing what changed.';
  const spec: AgentSpec = AgentSpecSchema.parse({
    name: 'Daily Watch',
    goal: 'Notify when a watched URL changes.',
    description:
      'On a daily schedule, fetch a URL, hash visible text, email a brief on change.',
    trigger: 'schedule',
    runtime: 'on_demand',
    inputs: [{ name: 'watch_url', description: 'URL to monitor.' }],
    capabilities: [
      { tool: 'http_request', why: 'Fetch the page.' },
      { tool: 'email_send', why: 'Deliver the brief.' },
    ],
    outputs: [{ name: 'change_brief', description: 'Summary of changes.' }],
    constraints: ['One HTTP request per run.'],
    success_criteria: ['Brief delivered before 9am.'],
    risk: 'medium',
    confidence: 0.9,
  });

  it('labels every required field', () => {
    const conf = computeAgentConfidence(spec, intent);
    for (const f of MOLD_REQUIRED_FIELDS.agent) {
      const level = conf[f];
      expect(level, "field '" + f + "' should be labelled").toBeDefined();
      expect(
        CONFIDENCE_LEVELS as readonly ConfidenceLevel[],
        "field '" + f + "' label '" + String(level) + "' must be a valid level",
      ).toContain(level!);
    }
  });

  it('marks trigger as stated when an anchor word (every / morning) appears', () => {
    const conf = computeAgentConfidence(spec, intent);
    expect(conf.trigger).toBe('stated');
  });

  it("marks trigger as 'guessed' when chosen='chat' and intent has no anchor", () => {
    const newSpec = AgentSpecSchema.parse({ ...spec, trigger: 'chat' });
    const conf = computeAgentConfidence(newSpec, 'do something useful');
    expect(conf.trigger).toBe('guessed');
  });

  it('marks missing fields as missing', () => {
    const blankSpec = AgentSpecSchema.parse({
      ...spec,
      constraints: [],
      success_criteria: [],
    });
    const conf = computeAgentConfidence(blankSpec, intent);
    expect(conf.constraints).toBe('missing');
    expect(conf.success_criteria).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// SYSTEM
// ---------------------------------------------------------------------------
describe('computeSystemConfidence', () => {
  const intent =
    'Every Monday morning, gather news, summarise each item, then aggregate to a weekly brief in a pipeline.';
  const spec: SystemSpec = SystemSpecSchema.parse({
    goal: 'Weekly news brief.',
    sub_agents: [
      {
        id: 'gatherer',
        role: 'Gatherer',
        description: 'Pulls news.',
        inputs: ['sources'],
        outputs: ['raw_items'],
      },
      {
        id: 'summariser',
        role: 'Summariser',
        description: 'Summarises each.',
        inputs: ['raw_items'],
        outputs: ['summaries'],
      },
      {
        id: 'brief_writer',
        role: 'Brief writer',
        description: 'Aggregates a weekly brief.',
        inputs: ['summaries'],
        outputs: ['brief'],
      },
    ],
    coordination: { pattern: 'pipeline', edges: [] },
    triggers: ['schedule'],
    max_steps: 25,
  });

  it('labels every required system field', () => {
    const conf = computeSystemConfidence(spec, intent);
    for (const f of MOLD_REQUIRED_FIELDS.system) {
      expect(conf[f], "field '" + f + "' should be labelled").toBeDefined();
    }
  });

  it("marks coordination_pattern as 'stated' when the intent mentions 'pipeline'", () => {
    const conf = computeSystemConfidence(spec, intent);
    expect(conf.coordination_pattern).toBe('stated');
  });

  it("marks max_steps as 'guessed' when it equals the schema default 25", () => {
    const conf = computeSystemConfidence(spec, intent);
    expect(conf.max_steps).toBe('guessed');
  });
});

// ---------------------------------------------------------------------------
// SOFTWARE
// ---------------------------------------------------------------------------
describe('computeSoftwareConfidence', () => {
  const intent =
    'A small expense tracker app where users submit expenses, view their own list, and approve them. Only the owner can see their data.';
  const spec: SoftwareSpec = SoftwareSpecSchema.parse({
    goal: 'Expense tracker.',
    pages: [{ id: 'list_expenses', name: 'List', purpose: 'List own expenses.' }],
    entities: [
      {
        name: 'Expense',
        fields: [
          { name: 'amount', type: 'number' },
          { name: 'category', type: 'string' },
        ],
      },
    ],
    flows: [],
    auth: { requires_auth: true, per_user_isolation: true },
    integrations: [],
  });

  it('labels every required software field', () => {
    const conf = computeSoftwareConfidence(spec, intent);
    for (const f of MOLD_REQUIRED_FIELDS.software) {
      expect(conf[f], "field '" + f + "' should be labelled").toBeDefined();
    }
  });

  it("marks auth_per_user_isolation as 'stated' when the intent mentions 'own data'", () => {
    const conf = computeSoftwareConfidence(spec, intent);
    expect(conf.auth_per_user_isolation).toBe('stated');
  });

  it("marks flows as 'missing' when none were extracted", () => {
    const conf = computeSoftwareConfidence(spec, intent);
    expect(conf.flows).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// INFRASTRUCTURE
// ---------------------------------------------------------------------------
describe('computeInfraConfidence', () => {
  const intent =
    'An events pipeline in us-east-1 with a FIFO queue, a worker, and a persistent Postgres database for production.';
  const spec: InfraSpec = InfraSpecSchema.parse({
    goal: 'Events pipeline.',
    resources: [
      { id: 'q', type: 'queue', config: { ordering: 'fifo' } },
      { id: 'w', type: 'worker', config: {} },
      { id: 'db', type: 'postgres_db', config: {} },
    ],
    topology: [
      { from: 'w', to: 'q' },
      { from: 'w', to: 'db' },
    ],
    region: 'us-east-1',
    lifecycle: 'persistent',
  });

  it('labels every required infra field', () => {
    const conf = computeInfraConfidence(spec, intent);
    for (const f of MOLD_REQUIRED_FIELDS.infrastructure) {
      expect(conf[f], "field '" + f + "' should be labelled").toBeDefined();
    }
  });

  it("marks region as 'stated' when the intent mentions it verbatim", () => {
    const conf = computeInfraConfidence(spec, intent);
    expect(conf.region).toBe('stated');
  });

  it("marks lifecycle as 'stated' when 'production' / 'persistent' appears", () => {
    const conf = computeInfraConfidence(spec, intent);
    expect(conf.lifecycle).toBe('stated');
  });
});

// ---------------------------------------------------------------------------
// DISPATCH
// ---------------------------------------------------------------------------
describe('computeConfidence dispatch', () => {
  it("routes 'agent' to the agent computer", () => {
    const spec: AgentSpec = AgentSpecSchema.parse({
      name: 'A',
      goal: 'g',
      description: 'd',
      trigger: 'chat',
      runtime: 'on_demand',
      inputs: [],
      capabilities: [],
      outputs: [],
      constraints: [],
      success_criteria: [],
      risk: 'low',
      confidence: 0.5,
    });
    const conf = computeConfidence('agent', spec, '');
    expect(conf.trigger).toBeDefined();
  });
});
