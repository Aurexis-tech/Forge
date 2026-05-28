// Aurexis Forge — eval golden case: SYSTEM mold.
//
// "Weekly news brief pipeline" — three sub-agents wired as a
// pipeline: gather (fetch sources) -> summarize (per-source) ->
// brief (aggregate into a single weekly brief).
//
// PINNED spec + OrchestrationPlan. Hand-authored. Pinning isolates
// codegen quality from spec/plan quality — when we tune the per-node
// codegen prompt, this spec+plan stay constant.

import type { SystemSpec } from '@/lib/engine/system/spec';
import type { OrchestrationPlan } from '@/lib/engine/system/planner/schema';
import type { GoldenCase } from './types';

const spec: SystemSpec = {
  goal: 'Produce a weekly brief summarising the most important news across a fixed list of sources.',
  sub_agents: [
    {
      id: 'gatherer',
      role: 'Source gatherer',
      description:
        'Fetches the latest items from each configured RSS / web source.',
      inputs: ['source_urls'],
      outputs: ['raw_items'],
      tools: ['http_request'],
    },
    {
      id: 'summariser',
      role: 'Per-source summariser',
      description:
        'Reads the raw items from each source and produces a short summary per item.',
      inputs: ['raw_items'],
      outputs: ['item_summaries'],
      tools: ['llm_completion'],
    },
    {
      id: 'brief_writer',
      role: 'Brief writer',
      description:
        'Aggregates the per-item summaries into a single weekly brief with a "top 3 themes" header.',
      inputs: ['item_summaries'],
      outputs: ['weekly_brief'],
      tools: ['llm_completion'],
    },
  ],
  coordination: {
    pattern: 'pipeline',
    edges: [
      { from: 'gatherer', to: 'summariser' },
      { from: 'summariser', to: 'brief_writer' },
    ],
  },
  triggers: ['schedule'],
  max_steps: 25,
};

const plan: OrchestrationPlan = {
  goal: spec.goal,
  pattern: 'pipeline',
  max_steps: 25,
  nodes: [
    {
      id: 'gatherer',
      role: 'Source gatherer',
      task: 'Fetch the configured source URLs sequentially via http_request and return a normalised { source, items[] } shape.',
      inputs: [{ from: null, output: 'source_urls' }],
      outputs: ['raw_items'],
      suggested_tools: [
        {
          requested: 'http_request',
          status: 'supported',
          registry_id: 'http_request',
          env_keys: [],
        },
      ],
    },
    {
      id: 'summariser',
      role: 'Per-source summariser',
      task: 'For each item, call llm_completion to produce a 2-3 sentence summary preserving the original source attribution.',
      inputs: [{ from: 'gatherer', output: 'raw_items' }],
      outputs: ['item_summaries'],
      suggested_tools: [
        {
          requested: 'llm_completion',
          status: 'supported',
          registry_id: 'llm_completion',
          env_keys: ['ANTHROPIC_API_KEY'],
        },
      ],
    },
    {
      id: 'brief_writer',
      role: 'Brief writer',
      task: 'Aggregate the per-item summaries into one weekly brief with a "top 3 themes" header, citing sources inline.',
      inputs: [{ from: 'summariser', output: 'item_summaries' }],
      outputs: ['weekly_brief'],
      suggested_tools: [
        {
          requested: 'llm_completion',
          status: 'supported',
          registry_id: 'llm_completion',
          env_keys: ['ANTHROPIC_API_KEY'],
        },
      ],
    },
  ],
  edges: [
    { from: 'gatherer', to: 'summariser', payload: 'raw_items' },
    { from: 'summariser', to: 'brief_writer', payload: 'item_summaries' },
  ],
  execution_order: ['gatherer', 'summariser', 'brief_writer'],
  warnings: [],
};

export const SYSTEM_GOLDEN: GoldenCase = {
  id: 'system.weekly_news_brief',
  kind: 'system',
  description:
    'Three-agent pipeline: gather sources -> summarise per item -> aggregate weekly brief.',
  // Natural-language INTENT for the spec-fidelity tier.
  intent:
    'Every Monday morning, gather the past-week\'s items from a fixed list of news source URLs, summarise each item in 2-3 sentences, then aggregate everything into one weekly brief with a "top 3 themes" header.',
  spec,
  plan,
  contract: {
    // The system generator emits one orchestrator + entrypoint + one
    // module per node. Plus the shared scaffold files.
    entrypointPath: 'src/system.ts',
    expectedFilePaths: [
      'src/orchestrator.ts',
      'src/system.ts',
      'src/modules/gatherer/index.ts',
      'src/modules/summariser/index.ts',
      'src/modules/brief_writer/index.ts',
    ],
    forbiddenImportPatterns: [
      /^react(\/|$)/,
      /^next(\/|$)/,
      /^@\/lib\/supabase/,
    ],
    requiredFileContents: [
      {
        path: 'src/modules/gatherer/index.ts',
        // The gatherer module must actually reference http_request
        // (not just stub the function body).
        mustMatchAny: [/http_request/, /httpRequest/i, /fetch/i],
      },
      {
        path: 'src/modules/summariser/index.ts',
        mustMatchAny: [/llm_completion/, /llmCompletion/, /complete/i],
      },
    ],
  },
};
