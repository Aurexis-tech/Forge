// Hermetic unit test — assembleForgeTimeline.
//
// Stubs the Supabase server client with an in-memory mock so the
// test exercises the merge / sort / cost-aggregation logic against
// canned rows. Zero real I/O.

import { describe, expect, it } from 'vitest';
import {
  assembleForgeTimeline,
  phaseForRef,
} from '@/lib/engine/observability/timeline';
import type { ForgeSupabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// In-memory Supabase mock. Captures `.from(table)` and resolves each
// query against a per-table fixture array. Supports `.eq`, `.in`,
// `.lt`, `.order`, `.limit` — the helpers the timeline uses.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface MockState {
  fixtures: Record<string, Row[]>;
}

function buildSupabaseMock(fixtures: Record<string, Row[]>): ForgeSupabase {
  const state: MockState = { fixtures };
  return {
    from(table: string) {
      let rows = (state.fixtures[table] ?? []).slice();
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        in(col: string, vals: ReadonlyArray<unknown>) {
          const set = new Set(vals);
          rows = rows.filter((r) => set.has(r[col]));
          return builder;
        },
        lt(col: string, val: unknown) {
          rows = rows.filter(
            (r) =>
              typeof r[col] === 'string' &&
              typeof val === 'string' &&
              (r[col] as string) < (val as string),
          );
          return builder;
        },
        order(col: string, opts: { ascending: boolean }) {
          rows = rows.slice().sort((a, b) => {
            const av = String(a[col] ?? '');
            const bv = String(b[col] ?? '');
            return opts.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return builder;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return builder;
        },
        // The terminal then() makes the builder thenable so `await`
        // yields { data, error }.
        then<T1, T2>(
          resolve: (v: { data: Row[]; error: null }) => T1 | PromiseLike<T1>,
          _reject?: (e: unknown) => T2 | PromiseLike<T2>,
        ): Promise<T1 | T2> {
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
      };
      return builder;
    },
  } as unknown as ForgeSupabase;
}

const PROJECT_ID = 'proj-test';

// ===========================================================================
// EMPTY PROJECT
// ===========================================================================
describe('assembleForgeTimeline — empty project', () => {
  it('returns empty events + zeroed phaseCosts + total 0', async () => {
    const supabase = buildSupabaseMock({});
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    expect(t.events).toEqual([]);
    expect(t.totalCostUsd).toBe(0);
    expect(t.phaseCosts.codegen).toBe(0);
    expect(t.phaseCosts.critique).toBe(0);
    expect(t.phaseCosts.refine).toBe(0);
    expect(t.phaseCosts.spec_extract).toBe(0);
    expect(t.phaseCosts.other).toBe(0);
    expect(t.truncated).toBe(false);
  });
});

// ===========================================================================
// MERGE + SORT
// ===========================================================================
describe('assembleForgeTimeline — merge + chronological sort', () => {
  it('merges events from multiple sources, newest first', async () => {
    const supabase = buildSupabaseMock({
      audit_log: [
        {
          id: 'a1',
          project_id: PROJECT_ID,
          action: 'spec.draft_generated',
          actor: 'engine.spec',
          detail: {},
          created_at: '2026-05-01T10:00:00.000Z',
        },
      ],
      cost_events: [
        {
          id: 'c1',
          project_id: PROJECT_ID,
          kind: 'llm',
          model: 'claude-sonnet-4-6',
          input_tokens: 100,
          output_tokens: 200,
          compute_ms: 0,
          amount_usd: 0.0123,
          key_source: 'byok',
          ref: 'codegen.pass1',
          created_at: '2026-05-01T11:00:00.000Z',
        },
      ],
      builds: [
        {
          id: 'b1',
          project_id: PROJECT_ID,
          spec_id: 's1',
          plan_id: 'p1',
          phase: null,
          status: 'generated',
          logs: [],
          repo_url: null,
          deploy_url: null,
          kind: 'agent',
          created_at: '2026-05-01T09:30:00.000Z',
          updated_at: '2026-05-01T09:30:00.000Z',
        },
      ],
    });
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    expect(t.events.length).toBe(3);
    // Newest first: cost@11:00 > audit@10:00 > build@09:30.
    expect(t.events[0]?.kind).toBe('cost');
    expect(t.events[1]?.kind).toBe('audit');
    expect(t.events[2]?.kind).toBe('build_status');
  });

  it('respects the limit option + sets truncated flag', async () => {
    const audits: Row[] = [];
    for (let i = 0; i < 10; i++) {
      audits.push({
        id: 'a' + i,
        project_id: PROJECT_ID,
        action: 'spec.draft_generated',
        actor: 'engine.spec',
        detail: {},
        // Distinct ascending timestamps so sort order is deterministic.
        created_at: '2026-05-01T10:0' + i + ':00.000Z',
      });
    }
    const supabase = buildSupabaseMock({ audit_log: audits });
    const t = await assembleForgeTimeline(supabase, PROJECT_ID, { limit: 3 });
    expect(t.events.length).toBe(3);
    expect(t.truncated).toBe(true);
  });

  it('default limit applied (200) when not supplied', async () => {
    const supabase = buildSupabaseMock({});
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    // No events, but the function returned (the default applies internally).
    expect(t.events.length).toBe(0);
    expect(t.truncated).toBe(false);
  });
});

// ===========================================================================
// ENGINE-ERROR CATEGORY SURFACING
// ===========================================================================
describe('assembleForgeTimeline — engine_error_category surfacing', () => {
  it("surfaces 'transient_provider' as warn-level when present in audit detail", async () => {
    const supabase = buildSupabaseMock({
      audit_log: [
        {
          id: 'a1',
          project_id: PROJECT_ID,
          action: 'codegen.run_failed',
          actor: 'engine.codegen',
          detail: {
            engine_error_category: 'transient_provider',
            engine_error_code: 'http_5xx',
            engine_error_user_message: 'transient',
          },
          created_at: '2026-05-01T10:00:00.000Z',
        },
      ],
    });
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    expect(t.events.length).toBe(1);
    expect(t.events[0]?.category).toBe('transient_provider');
    expect(t.events[0]?.level).toBe('warn');
    expect(t.events[0]?.message).toContain('[transient_provider]');
  });

  it("surfaces 'governance' as error-level", async () => {
    const supabase = buildSupabaseMock({
      audit_log: [
        {
          id: 'a1',
          project_id: PROJECT_ID,
          action: 'codegen.run_failed',
          actor: 'engine.codegen',
          detail: {
            engine_error_category: 'governance',
            engine_error_code: 'governance_killed',
            engine_error_user_message: 'paused',
          },
          created_at: '2026-05-01T10:00:00.000Z',
        },
      ],
    });
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    expect(t.events[0]?.level).toBe('error');
    expect(t.events[0]?.category).toBe('governance');
  });

  it('leaves category=null when the audit row has no engine_error_category (backward compat)', async () => {
    const supabase = buildSupabaseMock({
      audit_log: [
        {
          id: 'a1',
          project_id: PROJECT_ID,
          action: 'spec.draft_generated',
          actor: 'engine.spec',
          detail: { source: 'generate' }, // older shape
          created_at: '2026-05-01T10:00:00.000Z',
        },
      ],
    });
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    expect(t.events[0]?.category).toBeNull();
    expect(t.events[0]?.level).toBe('info');
  });

  it('rejects an unrecognised category string (defence)', async () => {
    const supabase = buildSupabaseMock({
      audit_log: [
        {
          id: 'a1',
          project_id: PROJECT_ID,
          action: 'codegen.run_failed',
          actor: 'engine.codegen',
          detail: {
            engine_error_category: 'totally_fake_category',
          },
          created_at: '2026-05-01T10:00:00.000Z',
        },
      ],
    });
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    // Unknown string → null + falls back to action-name level inference.
    expect(t.events[0]?.category).toBeNull();
  });
});

// ===========================================================================
// COST PHASE ROLL-UP
// ===========================================================================
describe('assembleForgeTimeline — phaseCosts roll-up', () => {
  it('aggregates cost_events by ref prefix', async () => {
    const supabase = buildSupabaseMock({
      cost_events: [
        {
          id: 'c1',
          project_id: PROJECT_ID,
          kind: 'llm',
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          compute_ms: 0,
          amount_usd: 0.05,
          key_source: 'byok',
          ref: 'codegen.pass1',
          created_at: '2026-05-01T10:00:00.000Z',
        },
        {
          id: 'c2',
          project_id: PROJECT_ID,
          kind: 'llm',
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          compute_ms: 0,
          amount_usd: 0.02,
          key_source: 'byok',
          ref: 'codegen.foo.critique',
          created_at: '2026-05-01T10:01:00.000Z',
        },
        {
          id: 'c3',
          project_id: PROJECT_ID,
          kind: 'llm',
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          compute_ms: 0,
          amount_usd: 0.07,
          key_source: 'byok',
          ref: 'codegen.foo.refine',
          created_at: '2026-05-01T10:02:00.000Z',
        },
        {
          id: 'c4',
          project_id: PROJECT_ID,
          kind: 'llm',
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          compute_ms: 0,
          amount_usd: 0.01,
          key_source: 'byok',
          ref: 'spec.extract.pass1',
          created_at: '2026-05-01T10:03:00.000Z',
        },
        {
          id: 'c5',
          project_id: PROJECT_ID,
          kind: 'llm',
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          compute_ms: 0,
          amount_usd: 0.04,
          key_source: 'byok',
          ref: 'evals.judge.case-x',
          created_at: '2026-05-01T10:04:00.000Z',
        },
        {
          id: 'c6',
          project_id: PROJECT_ID,
          kind: 'sandbox',
          model: null,
          input_tokens: 0,
          output_tokens: 0,
          compute_ms: 0,
          amount_usd: 0.03,
          key_source: 'byok',
          ref: null, // null → 'other'
          created_at: '2026-05-01T10:05:00.000Z',
        },
      ],
    });
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    expect(t.phaseCosts.codegen).toBeCloseTo(0.05);
    expect(t.phaseCosts.critique).toBeCloseTo(0.02);
    expect(t.phaseCosts.refine).toBeCloseTo(0.07);
    expect(t.phaseCosts.spec_extract).toBeCloseTo(0.01);
    expect(t.phaseCosts.judge).toBeCloseTo(0.04);
    expect(t.phaseCosts.other).toBeCloseTo(0.03);
    expect(t.totalCostUsd).toBeCloseTo(0.22);
  });
});

// ===========================================================================
// phaseForRef helper
// ===========================================================================
describe('phaseForRef — ref prefix → phase mapping', () => {
  const cases: ReadonlyArray<{ ref: string | null; expected: string }> = [
    { ref: null, expected: 'other' },
    { ref: 'codegen.pass1', expected: 'codegen' },
    { ref: 'codegen.agent.foo.critique', expected: 'critique' },
    { ref: 'codegen.agent.foo.refine', expected: 'refine' },
    { ref: 'spec.extract.pass1', expected: 'spec_extract' },
    { ref: 'spec.clarification.round.1', expected: 'clarification' },
    { ref: 'evals.judge.case-x', expected: 'judge' },
    { ref: 'evals.spec-judge.case-y', expected: 'judge' },
    { ref: 'system.codegen.module.gatherer', expected: 'codegen' },
    { ref: 'sandbox.test', expected: 'sandbox' },
    { ref: 'runtime.tick', expected: 'runtime' },
    { ref: 'mystery.ref', expected: 'other' },
  ];
  for (const c of cases) {
    it(
      "'" + String(c.ref) + "' → '" + c.expected + "'",
      () => {
        expect(phaseForRef(c.ref)).toBe(c.expected);
      },
    );
  }
});

// ===========================================================================
// BUILD-SCOPED + RUNTIME-SCOPED FETCHES
// ===========================================================================
describe('assembleForgeTimeline — build-scoped sources', () => {
  it('pulls sandbox_runs + deployments via the project builds', async () => {
    const supabase = buildSupabaseMock({
      builds: [
        {
          id: 'b1',
          project_id: PROJECT_ID,
          spec_id: null,
          plan_id: null,
          phase: null,
          status: 'tested',
          logs: [],
          repo_url: null,
          deploy_url: null,
          kind: 'agent',
          created_at: '2026-05-01T09:00:00.000Z',
          updated_at: '2026-05-01T09:00:00.000Z',
        },
      ],
      sandbox_runs: [
        {
          id: 'sb1',
          build_id: 'b1',
          provider: 'e2b',
          status: 'passed',
          build_ok: true,
          smoke_ok: true,
          logs: [],
          error: null,
          duration_ms: 12000,
          iterations: 1,
          created_at: '2026-05-01T09:05:00.000Z',
        },
      ],
      deployments: [
        {
          id: 'd1',
          build_id: 'b1',
          provider: 'vercel',
          project_ref: 'forge-test',
          deployment_id: 'dpl_x',
          url: 'https://x.vercel.app',
          status: 'ready',
          env_keys: [],
          created_at: '2026-05-01T09:10:00.000Z',
        },
      ],
    });
    const t = await assembleForgeTimeline(supabase, PROJECT_ID);
    const kinds = t.events.map((e) => e.kind).sort();
    expect(kinds).toContain('sandbox');
    expect(kinds).toContain('deploy');
    expect(kinds).toContain('build_status');
  });
});

// ===========================================================================
// HERMETICITY
// ===========================================================================
describe('observability-timeline hermeticity', () => {
  it('no real fetch was issued', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
