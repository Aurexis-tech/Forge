// Per-tool test — compute_regex_extract (ReDoS-safe).

import { describe, expect, it } from 'vitest';
import { callTool, COMPUTE_REGEX_EXTRACT } from '@/lib/engine/tools';
import { EngineError } from '@/lib/engine/errors';

const MODE = 'mock' as const;

type Out = { matches: string[]; groups?: Array<Record<string, string>> };

async function run(
  text: string,
  pattern: string,
  flags?: string,
  mode: 'mock' | 'runtime' = MODE,
): Promise<Out> {
  return (await callTool({
    name: 'compute_regex_extract',
    input: { text, pattern, flags },
    mode,
  })) as Out;
}

describe('compute_regex_extract — happy path', () => {
  it('extracts all digit matches', async () => {
    expect(await run('a1 b2 c3', '\\d')).toEqual({ matches: ['1', '2', '3'] });
  });

  it('returns numbered capture groups', async () => {
    expect(await run('id=7 id=8', 'id=(\\d)')).toEqual({
      matches: ['id=7', 'id=8'],
      groups: [{ '1': '7' }, { '1': '8' }],
    });
  });

  it('returns named capture groups', async () => {
    expect(await run('a@b', '(?<user>\\w)@(?<host>\\w)')).toEqual({
      matches: ['a@b'],
      groups: [{ user: 'a', host: 'b' }],
    });
  });

  it('honours caller flags (case-insensitive)', async () => {
    expect(await run('Aa', 'a', 'i')).toEqual({ matches: ['A', 'a'] });
  });
});

describe('compute_regex_extract — edge cases', () => {
  it('no matches → empty matches array, no groups', async () => {
    expect(await run('no digits', '\\d+')).toEqual({ matches: [] });
  });

  it('invalid regex → typed bad_input (not a raw throw)', async () => {
    try {
      await run('x', '(unclosed');
      expect.fail('expected bad_input');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe('regex_invalid');
    }
  });

  it('empty pattern rejected at the schema boundary', async () => {
    await expect(
      callTool({ name: 'compute_regex_extract', input: { text: 'x', pattern: '' }, mode: MODE }),
    ).rejects.toThrow(/input/);
  });
});

describe('compute_regex_extract — ReDoS safety (REQUIRED: no hang)', () => {
  it('a pathological nested-quantifier pattern returns bad_input and does NOT hang', async () => {
    const start = Date.now();
    let threw: unknown = null;
    try {
      // Classic catastrophic backtracking input. On an unguarded engine
      // this hangs for seconds→minutes; the guard must reject it instantly.
      await run('a'.repeat(40) + '!', '(a+)+$', undefined, 'runtime');
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - start;
    expect(threw).toBeInstanceOf(EngineError);
    expect((threw as EngineError).category).toBe('bad_input');
    expect((threw as EngineError).code).toBe('regex_catastrophic');
    // Must be effectively instant — generously under 1s proves no hang.
    expect(elapsed).toBeLessThan(1000);
  });

  it('rejects other nested-quantifier shapes: (a*)*, (.*)+, (a{2,})+', async () => {
    for (const pattern of ['(a*)*', '(.*)+', '(a{2,})+']) {
      try {
        await run('aaaa', pattern);
        expect.fail('expected rejection for ' + pattern);
      } catch (err) {
        expect((err as EngineError).code).toBe('regex_catastrophic');
      }
    }
  });

  it('does NOT reject safe non-nested patterns', async () => {
    // A single quantifier or a group without an inner quantifier is fine.
    await expect(run('aaa', 'a+')).resolves.toEqual({ matches: ['aaa'] });
    await expect(run('abab', '(ab)+')).resolves.toBeDefined();
  });
});

describe('compute_regex_extract — determinism', () => {
  it('same input → same output across 25 calls', async () => {
    const first = JSON.stringify(await run('x1y2z3', '(\\d)'));
    for (let i = 0; i < 24; i++) {
      expect(JSON.stringify(await run('x1y2z3', '(\\d)'))).toBe(first);
    }
  });
});

describe('compute_regex_extract — examples parse against schemas', () => {
  it('every example input + output parses', () => {
    for (const ex of COMPUTE_REGEX_EXTRACT.examples) {
      expect(COMPUTE_REGEX_EXTRACT.input_schema.safeParse(ex.input).success).toBe(true);
      expect(COMPUTE_REGEX_EXTRACT.output_schema.safeParse(ex.output).success).toBe(true);
    }
  });
});
