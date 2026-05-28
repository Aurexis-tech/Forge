// Per-tool test — parse_url.

import { describe, expect, it } from 'vitest';
import { callTool, PARSE_URL } from '@/lib/engine/tools';
import { EngineError } from '@/lib/engine/errors';

const MODE = 'mock' as const;

type Out = {
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  query: Record<string, string>;
  hash: string;
};

async function run(url: string): Promise<Out> {
  return (await callTool({ name: 'parse_url', input: { url }, mode: MODE })) as Out;
}

describe('parse_url — happy path', () => {
  it('parses a full URL with port, query, and hash', async () => {
    const o = await run('https://ex.com:8080/p/q?a=1&b=2#frag');
    expect(o).toEqual({
      protocol: 'https:',
      host: 'ex.com:8080',
      hostname: 'ex.com',
      port: '8080',
      pathname: '/p/q',
      search: '?a=1&b=2',
      query: { a: '1', b: '2' },
      hash: '#frag',
    });
  });

  it('parses a bare host with empty port/search/hash', async () => {
    const o = await run('http://localhost/');
    expect(o.port).toBe('');
    expect(o.query).toEqual({});
    expect(o.hash).toBe('');
    expect(o.pathname).toBe('/');
  });

  it('handles repeated query keys (last wins via searchParams.forEach)', async () => {
    const o = await run('https://e.com/?x=1&x=2');
    // URLSearchParams.forEach visits both; the record keeps the last.
    expect(o.query.x).toBe('2');
  });
});

describe('parse_url — edge cases', () => {
  it('invalid URL → typed bad_input (not a raw TypeError)', async () => {
    try {
      await run('not a url');
      expect.fail('expected bad_input');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).category).toBe('bad_input');
      expect((err as EngineError).code).toBe('url_invalid');
    }
  });

  it('a relative path (no protocol) is rejected as invalid', async () => {
    await expect(run('/just/a/path')).rejects.toBeInstanceOf(EngineError);
  });

  it('non-string url rejected at the schema boundary', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callTool({ name: 'parse_url', input: { url: 42 as any }, mode: MODE }),
    ).rejects.toThrow(/input/);
  });
});

describe('parse_url — determinism', () => {
  it('same URL → same output across 25 calls', async () => {
    const first = JSON.stringify(await run('https://a.b/c?d=e#f'));
    for (let i = 0; i < 24; i++) {
      expect(JSON.stringify(await run('https://a.b/c?d=e#f'))).toBe(first);
    }
  });
});

describe('parse_url — examples parse against schemas', () => {
  it('every example input + output parses', () => {
    for (const ex of PARSE_URL.examples) {
      expect(PARSE_URL.input_schema.safeParse(ex.input).success).toBe(true);
      expect(PARSE_URL.output_schema.safeParse(ex.output).success).toBe(true);
    }
  });
});
