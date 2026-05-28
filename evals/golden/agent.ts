// Aurexis Forge — eval golden case: AGENT mold.
//
// "Daily website-change watcher" — an on-demand agent that fetches a
// fixed URL, computes a content hash, compares it to the previous
// hash, and emits a brief if anything changed.
//
// PINNED spec + plan. Hand-authored, NOT extracted from intent text.
// Pinning isolates GENERATION quality from spec/plan quality so the
// eval measures one variable at a time. When we tune the codegen
// prompt, the spec + plan are held constant; only the LLM output
// moves.

import type { AgentSpec } from '@/lib/engine/spec/schema';
import type { BuildPlan } from '@/lib/engine/planner/schema';
import type { GoldenCase } from './types';

const spec: AgentSpec = {
  name: 'Daily Website Watch',
  goal: 'Notify when a watched URL changes content from the prior day.',
  description:
    'On a daily schedule, fetch a fixed URL, compute a sha256 of the visible text, compare to the prior run, and emit a short change-summary brief when the hash differs. Stays silent on no-change days.',
  trigger: 'schedule',
  runtime: 'on_demand',
  inputs: [
    {
      name: 'watch_url',
      description: 'The URL the agent monitors. Provided as agent input.',
    },
  ],
  capabilities: [
    {
      tool: 'http_request',
      why: 'Fetch the watched URL content over HTTP.',
    },
    {
      tool: 'file_read',
      why: 'Read the prior run\'s stored hash from agent storage.',
    },
    {
      tool: 'file_write',
      why: 'Persist the new hash for the next run.',
    },
    {
      tool: 'llm_completion',
      why: 'Summarise the diff into a short human-readable brief.',
    },
  ],
  outputs: [
    {
      name: 'change_brief',
      description:
        'A short paragraph describing what changed since the prior run. Empty when nothing changed.',
    },
  ],
  constraints: [
    'Never make more than one HTTP request per run.',
    'Never log the full page body; only the hash and the brief.',
    'Skip the brief entirely when the hash is unchanged.',
  ],
  success_criteria: [
    'Two consecutive runs against the same unchanged URL emit no brief.',
    'A run against a URL whose content has changed emits a non-empty brief.',
    'The brief mentions concrete content, not just "the page changed".',
  ],
  risk: 'low',
  confidence: 0.9,
};

const plan: BuildPlan = {
  scaffold: 'agent-node-tool-using',
  target: {
    framework: 'nodejs',
    hosting: 'vercel_function',
    entrypoint: 'src/index.ts',
  },
  trigger_impl:
    'Vercel cron at 09:00 UTC daily invokes the function handler with the watch_url input.',
  runtime_impl: 'on_demand',
  tools: [
    {
      requested: 'http_request',
      status: 'supported',
      registry_id: 'http_request',
      env_keys: [],
    },
    {
      requested: 'file_read',
      status: 'supported',
      registry_id: 'file_read',
      env_keys: [],
    },
    {
      requested: 'file_write',
      status: 'supported',
      registry_id: 'file_write',
      env_keys: [],
    },
    {
      requested: 'llm_completion',
      status: 'supported',
      registry_id: 'llm_completion',
      env_keys: ['ANTHROPIC_API_KEY'],
    },
  ],
  files: [
    { path: 'src/index.ts', purpose: 'Entrypoint — runs one watch cycle.' },
    {
      path: 'src/diff.ts',
      purpose: 'Computes sha256 + extracts visible text from raw HTML.',
    },
    {
      path: 'src/storage.ts',
      purpose:
        'Loads + persists the prior-run hash via the scaffold\'s file tools.',
    },
  ],
  env_required: [
    {
      key: 'ANTHROPIC_API_KEY',
      why: 'Required for the llm_completion tool that writes the change brief.',
      secret: true,
    },
  ],
  tasks: [
    {
      id: 'fetch_page',
      title: 'Fetch the watched URL',
      description:
        'GET the watch_url via the http_request tool and return its raw body.',
      depends_on: [],
    },
    {
      id: 'compute_hash',
      title: 'Compute content hash',
      description:
        'Extract visible text, compute sha256, and compare to the stored prior hash.',
      depends_on: ['fetch_page'],
    },
    {
      id: 'summarise_diff',
      title: 'Summarise the change',
      description:
        'When the hash differs, call llm_completion with the old + new text to produce a short brief.',
      depends_on: ['compute_hash'],
    },
    {
      id: 'persist_hash',
      title: 'Persist the new hash',
      description:
        'Write the new hash via file_write so the next run can compare.',
      depends_on: ['compute_hash'],
    },
  ],
  estimate: {
    risk: 'low',
    complexity: 'low',
    notes:
      'Three small TS modules, four tasks, four tools. Standard cron-fetch shape.',
  },
  warnings: [],
};

export const AGENT_GOLDEN: GoldenCase = {
  id: 'agent.daily_website_watch',
  kind: 'agent',
  description: 'Daily website-change watcher (cron → fetch → diff → brief).',
  // Natural-language INTENT — what a user would type. The spec-fidelity
  // tier drives the real extractor with this and scores the produced
  // spec against the pinned `spec` below.
  intent:
    'Every morning at 9am, fetch a URL I configure, compare the page content to yesterday\'s, and email me a short brief describing what changed. Stay silent when nothing changed.',
  spec,
  plan,
  contract: {
    entrypointPath: 'src/index.ts',
    expectedFilePaths: ['src/index.ts', 'src/diff.ts', 'src/storage.ts'],
    // The agent scaffold provides tool shims; generated logic should
    // only import from the scaffold's tool surface or from node core /
    // standard libs. Anything else is suspicious for an agent module.
    forbiddenImportPatterns: [
      // No client-side React in an agent.
      /^react(\/|$)/,
      /^next(\/|$)/,
      // No supabase server lib in an agent (agents talk to their own
      // storage tools, not the platform DB).
      /^@\/lib\/supabase/,
    ],
    // The summariser file should actually call the llm tool, not
    // return a hardcoded string.
    requiredFileContents: [
      {
        path: 'src/index.ts',
        // The entrypoint must wire the watch_url input and call the
        // tool surface — a smoke check for non-stub output.
        mustMatchAny: [/watch_url/i, /watchUrl/],
      },
    ],
  },
};
