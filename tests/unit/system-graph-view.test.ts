// Unit test: SystemGraphView's pure logic — `deriveNodeRunStatuses`
// maps a run row's outcome onto per-node statuses, and the rendered
// SVG carries the expected node + edge structure.
//
// We do NOT render with @testing-library here (no react-dom shim in
// vitest); instead we exercise the pure helper directly + spot-check
// the SVG output by rendering through React's server-side renderer
// API only when needed. The helper alone covers the per-run overlay
// logic; the rest is presentational.

import { describe, expect, it } from 'vitest';
import {
  deriveNodeRunStatuses,
} from '@/components/system/SystemGraphView';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '@/lib/engine/system/planner/schema';
import type { AgentRun } from '@/lib/types';

const PLAN: OrchestrationPlan = OrchestrationPlanSchema.parse({
  goal: 'arxiv pipeline',
  pattern: 'pipeline',
  max_steps: 25,
  nodes: [
    {
      id: 'scraper',
      role: 'scraper',
      task: 'x',
      inputs: [{ from: null, output: 'time_window' }],
      outputs: ['raw_papers'],
      suggested_tools: [],
    },
    {
      id: 'summarizer',
      role: 'summarizer',
      task: 'x',
      inputs: [{ from: 'scraper', output: 'raw_papers' }],
      outputs: ['summary'],
      suggested_tools: [],
    },
    {
      id: 'emailer',
      role: 'emailer',
      task: 'x',
      inputs: [{ from: 'summarizer', output: 'summary' }],
      outputs: ['delivery_receipt'],
      suggested_tools: [],
    },
  ],
  edges: [
    { from: 'scraper', to: 'summarizer', payload: 'raw_papers' },
    { from: 'summarizer', to: 'emailer', payload: 'summary' },
  ],
  execution_order: ['scraper', 'summarizer', 'emailer'],
  warnings: [],
});

function makeRun(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: 'run-1',
    runtime_id: 'rt-1',
    trigger: 'tick',
    status: 'succeeded',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 1000,
    logs: [],
    output: null,
    error: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('deriveNodeRunStatuses', () => {
  it('no run → every node is "idle"', () => {
    const s = deriveNodeRunStatuses(PLAN, null);
    expect(s.get('scraper')).toBe('idle');
    expect(s.get('summarizer')).toBe('idle');
    expect(s.get('emailer')).toBe('idle');
  });

  it('succeeded run → every node is "passed"', () => {
    const s = deriveNodeRunStatuses(PLAN, makeRun({ status: 'succeeded' }));
    expect(s.get('scraper')).toBe('passed');
    expect(s.get('summarizer')).toBe('passed');
    expect(s.get('emailer')).toBe('passed');
  });

  it('running run → every node is "pending" (cursor unknown mid-flight)', () => {
    const s = deriveNodeRunStatuses(PLAN, makeRun({ status: 'running' }));
    expect(s.get('scraper')).toBe('pending');
    expect(s.get('summarizer')).toBe('pending');
    expect(s.get('emailer')).toBe('pending');
  });

  it('failed run + handoff failure at summarizer → scraper=passed, summarizer=failed, emailer=pending', () => {
    const run = makeRun({
      status: 'failed',
      error: 'handoff failed at summarizer',
      logs: [
        { stream: 'system', message: 'phase.install', at: '0' },
        {
          stream: 'run/stdout',
          message:
            '[run] orchestrate_failed {"node":"summarizer","message":"handoff validation failed"}',
          at: '1',
        },
      ] as unknown as AgentRun['logs'],
    });
    const s = deriveNodeRunStatuses(PLAN, run);
    expect(s.get('scraper')).toBe('passed');
    expect(s.get('summarizer')).toBe('failed');
    expect(s.get('emailer')).toBe('pending');
  });

  it('failed run + no parseable marker → every node "pending" (no fabricated trail)', () => {
    const run = makeRun({
      status: 'failed',
      error: 'install failed',
      logs: [
        { stream: 'system', message: 'install died', at: '0' },
      ] as unknown as AgentRun['logs'],
    });
    const s = deriveNodeRunStatuses(PLAN, run);
    expect(s.get('scraper')).toBe('pending');
    expect(s.get('summarizer')).toBe('pending');
    expect(s.get('emailer')).toBe('pending');
  });

  it('failed run + failing node at FIRST position → first=failed, rest=pending', () => {
    const run = makeRun({
      status: 'failed',
      logs: [
        {
          stream: 'run/stdout',
          message:
            '[run] orchestrate_failed {"node":"scraper","message":"missing input"}',
          at: '0',
        },
      ] as unknown as AgentRun['logs'],
    });
    const s = deriveNodeRunStatuses(PLAN, run);
    expect(s.get('scraper')).toBe('failed');
    expect(s.get('summarizer')).toBe('pending');
    expect(s.get('emailer')).toBe('pending');
  });

  it('failed run + failing node at LAST position → all earlier passed, last=failed', () => {
    const run = makeRun({
      status: 'failed',
      logs: [
        {
          stream: 'run/stdout',
          message:
            '[run] orchestrate_failed {"node":"emailer","message":"send error"}',
          at: '0',
        },
      ] as unknown as AgentRun['logs'],
    });
    const s = deriveNodeRunStatuses(PLAN, run);
    expect(s.get('scraper')).toBe('passed');
    expect(s.get('summarizer')).toBe('passed');
    expect(s.get('emailer')).toBe('failed');
  });

  it('LATEST orchestrate_failed line wins (multiple lines in logs)', () => {
    // The walker scans backwards; the most recent marker is the one
    // that ultimately failed the run.
    const run = makeRun({
      status: 'failed',
      logs: [
        {
          stream: 'run/stdout',
          message:
            '[run] orchestrate_failed {"node":"scraper","message":"first try"}',
          at: '0',
        },
        {
          stream: 'run/stdout',
          message:
            '[run] orchestrate_failed {"node":"emailer","message":"second try"}',
          at: '1',
        },
      ] as unknown as AgentRun['logs'],
    });
    const s = deriveNodeRunStatuses(PLAN, run);
    expect(s.get('scraper')).toBe('passed');
    expect(s.get('summarizer')).toBe('passed');
    expect(s.get('emailer')).toBe('failed');
  });

  it('every node in the plan appears in the status map', () => {
    const s = deriveNodeRunStatuses(PLAN, null);
    expect(s.size).toBe(PLAN.nodes.length);
    for (const n of PLAN.nodes) expect(s.has(n.id)).toBe(true);
  });
});
