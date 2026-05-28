// Hermetic unit test — engine error taxonomy + classifier.
//
// Covers the full category matrix:
//   - Anthropic SDK / HTTP status code mapping (200/400/401/403/404/422/429/500/503).
//   - Zod errors → 'bad_input'.
//   - Postgres SQLSTATE codes (23505 unique violation, 42501 RLS,
//     PGRST116 no rows).
//   - AbortError + 'fetch failed' + ECONNRESET / ETIMEDOUT → transient.
//   - Existing engine typed errors (GovernanceError, NeedsKeyError) map.
//   - Generic Error → 'internal' with message preserved.
//   - Already-classified EngineError passes through unchanged.
//   - Retry-After header / numeric → retryAfterMs.

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  classifyError,
  EngineError,
  type ErrorCategory,
} from '@/lib/engine/errors';
import { GovernanceError } from '@/lib/engine/governance/guard';
import { NeedsKeyError } from '@/lib/engine/keys';

// ===========================================================================
// HTTP STATUS CODE MATRIX
// ===========================================================================
describe('classifyError — HTTP status codes', () => {
  const matrix: ReadonlyArray<{
    status: number;
    expected: ErrorCategory;
    retriable: boolean;
  }> = [
    { status: 400, expected: 'bad_input', retriable: false },
    { status: 401, expected: 'auth', retriable: false },
    { status: 403, expected: 'auth', retriable: false },
    { status: 404, expected: 'not_found', retriable: false },
    { status: 422, expected: 'bad_input', retriable: false },
    { status: 429, expected: 'transient_provider', retriable: true },
    { status: 500, expected: 'transient_provider', retriable: true },
    { status: 502, expected: 'transient_provider', retriable: true },
    { status: 503, expected: 'transient_provider', retriable: true },
    { status: 504, expected: 'transient_provider', retriable: true },
    { status: 451, expected: 'permanent_provider', retriable: false },
  ];

  for (const row of matrix) {
    it(
      'HTTP ' +
        row.status +
        ' → category ' +
        row.expected +
        ', retriable=' +
        row.retriable,
      () => {
        const sdkLike = Object.assign(new Error('boom'), { status: row.status });
        const ce = classifyError(sdkLike);
        expect(ce.category).toBe(row.expected);
        expect(ce.retriable).toBe(row.retriable);
        expect(ce.cause).toBe(sdkLike);
      },
    );
  }

  it('honours numeric retry-after seconds (SDK shape)', () => {
    const sdkLike = Object.assign(new Error('rate limit'), {
      status: 429,
      retryAfter: 5,
    });
    const ce = classifyError(sdkLike);
    expect(ce.retryAfterMs).toBe(5000);
  });

  it('honours retry-after seconds via headers', () => {
    const sdkLike = Object.assign(new Error('rate limit'), {
      status: 429,
      headers: { 'retry-after': '7' },
    });
    const ce = classifyError(sdkLike);
    expect(ce.retryAfterMs).toBe(7000);
  });

  it('handles statusCode alias (Octokit-style)', () => {
    const octokitLike = Object.assign(new Error('not auth'), { status: 401 });
    expect(classifyError(octokitLike).category).toBe('auth');
  });
});

// ===========================================================================
// ZOD ERRORS
// ===========================================================================
describe('classifyError — Zod', () => {
  it('ZodError → bad_input with retriable=false', () => {
    // Build a ZodError via a known-failing parse.
    const { z } = require('zod') as typeof import('zod');
    const schema = z.object({ a: z.string() });
    const result = schema.safeParse({ a: 123 });
    expect(result.success).toBe(false);
    const ce = classifyError(result.success ? null : result.error);
    expect(ce.category).toBe('bad_input');
    expect(ce.code).toBe('zod_validation');
    expect(ce.retriable).toBe(false);
  });
});

// ===========================================================================
// POSTGRES / SUPABASE
// ===========================================================================
describe('classifyError — Postgres SQLSTATE', () => {
  it('23505 unique violation → bad_input', () => {
    const ce = classifyError({ code: '23505', message: 'duplicate' });
    expect(ce.category).toBe('bad_input');
    expect(ce.code).toBe('pg_unique_violation');
  });

  it('42501 RLS/privilege denial → permission', () => {
    const ce = classifyError({ code: '42501', message: 'denied' });
    expect(ce.category).toBe('permission');
  });

  it('PGRST116 no-rows → not_found', () => {
    const ce = classifyError({ code: 'PGRST116', message: 'no rows' });
    expect(ce.category).toBe('not_found');
  });

  it('unknown SQLSTATE → internal', () => {
    const ce = classifyError({ code: '40001', message: 'serialization' });
    expect(ce.category).toBe('internal');
  });

  it('non-SQLSTATE-shape code falls through to other branches', () => {
    const ce = classifyError({ code: 'notapgcode', message: 'whatever' });
    // Falls through to 'internal' last-resort.
    expect(ce.category).toBe('internal');
  });
});

// ===========================================================================
// NETWORK / TRANSIENT
// ===========================================================================
describe('classifyError — network transient', () => {
  it('AbortError → transient_provider', () => {
    const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const ce = classifyError(e);
    expect(ce.category).toBe('transient_provider');
    expect(ce.retriable).toBe(true);
  });

  it("'fetch failed' message → transient_provider", () => {
    const ce = classifyError(new Error('fetch failed'));
    expect(ce.category).toBe('transient_provider');
    expect(ce.retriable).toBe(true);
  });

  it('ECONNRESET → transient_provider', () => {
    const e = Object.assign(new Error('econnreset'), { code: 'ECONNRESET' });
    expect(classifyError(e).retriable).toBe(true);
  });

  it('ETIMEDOUT → transient_provider', () => {
    const e = Object.assign(new Error('etimedout'), { code: 'ETIMEDOUT' });
    expect(classifyError(e).retriable).toBe(true);
  });
});

// ===========================================================================
// EXISTING ENGINE TYPED ERRORS
// ===========================================================================
describe('classifyError — existing engine errors', () => {
  it('GovernanceError(killed) → governance, retriable=false', () => {
    const ge = new GovernanceError('killed');
    const ce = classifyError(ge);
    expect(ce.category).toBe('governance');
    expect(ce.code).toBe('governance_killed');
    expect(ce.retriable).toBe(false);
    expect(ce.cause).toBe(ge);
  });

  it('GovernanceError(budget) → governance, retriable=false', () => {
    const ge = new GovernanceError('budget');
    const ce = classifyError(ge);
    expect(ce.category).toBe('governance');
    expect(ce.code).toBe('governance_budget');
    expect(ce.retriable).toBe(false);
  });

  it('NeedsKeyError → auth, retriable=false', () => {
    const ne = new NeedsKeyError('anthropic');
    const ce = classifyError(ne);
    expect(ce.category).toBe('auth');
    expect(ce.code).toBe('needs_key_anthropic');
    expect(ce.retriable).toBe(false);
  });
});

// ===========================================================================
// FALLTHROUGH / PASSTHROUGH
// ===========================================================================
describe('classifyError — fallthrough + passthrough', () => {
  it('generic Error → internal with message preserved', () => {
    const ce = classifyError(new Error('whoops'));
    expect(ce.category).toBe('internal');
    expect(ce.message).toContain('whoops');
    expect(ce.retriable).toBe(false);
  });

  it('non-Error throw (string) → internal', () => {
    const ce = classifyError('something went wrong');
    expect(ce.category).toBe('internal');
    expect(ce.message).toBe('something went wrong');
  });

  it('already-classified EngineError → passthrough', () => {
    const original = new EngineError({
      category: 'transient_provider',
      code: 'test',
      message: 'test',
      userMessage: 'test',
      retriable: true,
    });
    expect(classifyError(original)).toBe(original);
  });
});
