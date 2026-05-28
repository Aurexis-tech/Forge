// Hermetic unit test — auditEngineError helper.
//
// Stubs the Supabase server client + the classifier-relevant
// errors. Verifies the right detail keys land in the insert
// payload and that `extra` cannot overwrite the reserved engine
// error keys.

import { describe, expect, it, vi } from 'vitest';
import { auditEngineError } from '@/lib/engine/observability/audit-engine-error';
import { GovernanceError } from '@/lib/engine/governance/guard';
import type { ForgeSupabase } from '@/lib/supabase';

interface InsertCapture {
  table: string;
  payload: Record<string, unknown>;
}

function buildSupabaseMock(opts?: {
  failInsert?: boolean;
}): { supabase: ForgeSupabase; captured: InsertCapture[] } {
  const captured: InsertCapture[] = [];
  const supabase = {
    from(table: string) {
      return {
        async insert(payload: Record<string, unknown>) {
          captured.push({ table, payload });
          return opts?.failInsert
            ? { error: { message: 'simulated DB error' } }
            : { error: null };
        },
      };
    },
  } as unknown as ForgeSupabase;
  return { supabase, captured };
}

// ===========================================================================
// CLASSIFY + INSERT
// ===========================================================================
describe('auditEngineError — classification + insert', () => {
  it('classifies an HTTP 503 and writes the engine_error_* keys', async () => {
    const { supabase, captured } = buildSupabaseMock();
    const err = Object.assign(new Error('5xx'), { status: 503 });
    const classified = await auditEngineError({
      supabase,
      projectId: 'proj-x',
      action: 'codegen.run_failed',
      err,
    });
    expect(classified.category).toBe('transient_provider');
    expect(captured.length).toBe(1);
    expect(captured[0]?.table).toBe('audit_log');
    const payload = captured[0]?.payload as {
      project_id: string;
      action: string;
      actor: string;
      detail: Record<string, unknown>;
    };
    expect(payload.project_id).toBe('proj-x');
    expect(payload.action).toBe('codegen.run_failed');
    expect(payload.actor).toBe('engine'); // default
    expect(payload.detail.engine_error_category).toBe('transient_provider');
    expect(payload.detail.engine_error_code).toBe('http_5xx');
    expect(typeof payload.detail.engine_error_user_message).toBe('string');
  });

  it('classifies GovernanceError', async () => {
    const { supabase, captured } = buildSupabaseMock();
    await auditEngineError({
      supabase,
      projectId: 'proj-x',
      action: 'codegen.run_failed',
      err: new GovernanceError('killed'),
    });
    const detail = (captured[0]?.payload as { detail: Record<string, unknown> })
      .detail;
    expect(detail.engine_error_category).toBe('governance');
    expect(detail.engine_error_code).toBe('governance_killed');
  });

  it('classifies an unknown Error as internal', async () => {
    const { supabase, captured } = buildSupabaseMock();
    await auditEngineError({
      supabase,
      projectId: 'proj-x',
      action: 'codegen.run_failed',
      err: new Error('mystery'),
    });
    const detail = (captured[0]?.payload as { detail: Record<string, unknown> })
      .detail;
    expect(detail.engine_error_category).toBe('internal');
    expect(detail.engine_error_code).toBe('unexpected');
  });

  it('honours actor override', async () => {
    const { supabase, captured } = buildSupabaseMock();
    await auditEngineError({
      supabase,
      projectId: 'proj-x',
      action: 'codegen.run_failed',
      err: new Error('boom'),
      actor: 'engine.codegen',
    });
    expect((captured[0]?.payload as { actor: string }).actor).toBe(
      'engine.codegen',
    );
  });
});

// ===========================================================================
// EXTRA FIELDS
// ===========================================================================
describe('auditEngineError — extra fields', () => {
  it("merges 'extra' fields under detail without overwriting engine_error_*", async () => {
    const { supabase, captured } = buildSupabaseMock();
    await auditEngineError({
      supabase,
      projectId: 'proj-x',
      action: 'codegen.run_failed',
      err: Object.assign(new Error('5xx'), { status: 503 }),
      extra: { build_id: 'b1', step: 'pass1' },
    });
    const detail = (captured[0]?.payload as { detail: Record<string, unknown> })
      .detail;
    expect(detail.build_id).toBe('b1');
    expect(detail.step).toBe('pass1');
    // Engine keys still authoritative.
    expect(detail.engine_error_category).toBe('transient_provider');
  });

  it("STRIPS reserved keys from 'extra' — caller cannot shadow engine_error_*", async () => {
    const { supabase, captured } = buildSupabaseMock();
    await auditEngineError({
      supabase,
      projectId: 'proj-x',
      action: 'codegen.run_failed',
      err: Object.assign(new Error('5xx'), { status: 503 }),
      extra: {
        // Attempt to hijack the helper's keys.
        engine_error_category: 'governance',
        engine_error_code: 'oops',
        engine_error_user_message: 'hijack',
        build_id: 'b1',
      } as Record<string, unknown>,
    });
    const detail = (captured[0]?.payload as { detail: Record<string, unknown> })
      .detail;
    // The classifier-derived values must WIN.
    expect(detail.engine_error_category).toBe('transient_provider');
    expect(detail.engine_error_code).toBe('http_5xx');
    expect(detail.engine_error_user_message).not.toBe('hijack');
    // Non-reserved extra still survives.
    expect(detail.build_id).toBe('b1');
  });
});

// ===========================================================================
// SAFETY
// ===========================================================================
describe('auditEngineError — safety', () => {
  it('swallows DB insert errors silently (never throws out of catch)', async () => {
    const { supabase } = buildSupabaseMock({ failInsert: true });
    // Should NOT throw even though the insert fails.
    await expect(
      auditEngineError({
        supabase,
        projectId: 'proj-x',
        action: 'codegen.run_failed',
        err: new Error('something'),
      }),
    ).resolves.toBeDefined();
  });

  it("swallows a thrown DB error too", async () => {
    const supabase = {
      from() {
        return {
          insert() {
            throw new Error('connection refused');
          },
        };
      },
    } as unknown as ForgeSupabase;
    await expect(
      auditEngineError({
        supabase,
        projectId: 'proj-x',
        action: 'codegen.run_failed',
        err: new Error('something'),
      }),
    ).resolves.toBeDefined();
  });

  it('returns the classified error for the caller to re-throw if desired', async () => {
    const { supabase } = buildSupabaseMock();
    const classified = await auditEngineError({
      supabase,
      projectId: 'proj-x',
      action: 'codegen.run_failed',
      err: Object.assign(new Error('boom'), { status: 401 }),
    });
    expect(classified.category).toBe('auth');
  });
});

// ===========================================================================
// HERMETICITY
// ===========================================================================
describe('audit-engine-error hermeticity', () => {
  it('no real fetch was issued', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
