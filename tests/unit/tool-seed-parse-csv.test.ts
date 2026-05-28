// Per-tool test — parse_csv (papaparse).

import { describe, expect, it } from 'vitest';
import { callTool, PARSE_CSV } from '@/lib/engine/tools';
import { EngineError } from '@/lib/engine/errors';

const MODE = 'mock' as const;

async function run(csv: string, header?: boolean): Promise<unknown> {
  return callTool({ name: 'parse_csv', input: { csv, header }, mode: MODE });
}

describe('parse_csv — happy path (header)', () => {
  it('parses rows as records + returns fields', async () => {
    const o = (await run('a,b\n1,2\n3,4', true)) as {
      rows: Array<Record<string, string>>;
      fields: string[];
    };
    expect(o.rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    expect(o.fields).toEqual(['a', 'b']);
  });

  it('values stay strings (no dynamic typing)', async () => {
    const o = (await run('n\n42', true)) as { rows: Array<Record<string, string>> };
    expect(o.rows[0]!.n).toBe('42');
    expect(typeof o.rows[0]!.n).toBe('string');
  });
});

describe('parse_csv — happy path (no header)', () => {
  it('parses rows as string[][]', async () => {
    const o = (await run('1,2\n3,4', false)) as { rows: string[][] };
    expect(o.rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('defaults to no-header when omitted', async () => {
    const o = (await run('x,y')) as { rows: string[][] };
    expect(o.rows).toEqual([['x', 'y']]);
  });
});

describe('parse_csv — edge cases', () => {
  it('empty CSV → empty rows (not an error)', async () => {
    const o = (await run('', true)) as { rows: unknown[] };
    expect(o.rows).toEqual([]);
  });

  it('malformed CSV (unterminated quote) → typed bad_input', async () => {
    try {
      await run('name,age\n"unterminated,30', true);
      expect.fail('expected bad_input');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe('csv_malformed');
    }
  });

  it('non-string csv rejected at the schema boundary', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callTool({ name: 'parse_csv', input: { csv: 5 as any }, mode: MODE }),
    ).rejects.toThrow(/input/);
  });
});

describe('parse_csv — determinism', () => {
  it('same input → same output across 25 calls', async () => {
    const first = JSON.stringify(await run('a,b\n1,2\n3,4', true));
    for (let i = 0; i < 24; i++) {
      expect(JSON.stringify(await run('a,b\n1,2\n3,4', true))).toBe(first);
    }
  });
});

describe('parse_csv — examples parse against schemas', () => {
  it('every example input + output parses', () => {
    for (const ex of PARSE_CSV.examples) {
      expect(PARSE_CSV.input_schema.safeParse(ex.input).success).toBe(true);
      expect(PARSE_CSV.output_schema.safeParse(ex.output).success).toBe(true);
    }
  });
});
