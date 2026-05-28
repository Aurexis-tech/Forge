// Per-tool test — parse.json seed tool.

import { describe, expect, it } from 'vitest';
import { callTool, PARSE_JSON } from '@/lib/engine/tools';

const MODE = 'mock' as const;

describe('parse.json — happy path', () => {
  it('parses a raw JSON object without recovery', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: { text: '{"a":1,"b":2}' },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toEqual({ a: 1, b: 2 });
    expect(out.recovered).toBe(false);
  });

  it('parses a raw JSON array without recovery', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: { text: '[1,2,3]' },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toEqual([1, 2, 3]);
    expect(out.recovered).toBe(false);
  });
});

describe('parse.json — recovery paths', () => {
  it('strips ```json fences and recovers', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: { text: 'Here:\n```json\n{"ok": true}\n```\nDone.' },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toEqual({ ok: true });
    expect(out.recovered).toBe(true);
  });

  it('strips bare ``` fences and recovers', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: { text: '```\n{"x": 1}\n```' },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toEqual({ x: 1 });
    expect(out.recovered).toBe(true);
  });

  it('extracts a brace substring from prose-leading text', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: { text: 'The result was {"status": "ok"} as you can see.' },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toEqual({ status: 'ok' });
    expect(out.recovered).toBe(true);
  });

  it('handles nested objects + strings that look like braces', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: {
        text: 'pre {"outer": {"inner": "} not a close"}, "n": 1} post',
      },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toEqual({ outer: { inner: '} not a close' }, n: 1 });
    expect(out.recovered).toBe(true);
  });
});

describe('parse.json — edge cases', () => {
  it('returns parsed:null + recovered:false when text has no JSON', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: { text: 'just plain words, nothing structured' },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toBeNull();
    expect(out.recovered).toBe(false);
  });

  it('returns parsed:null when text is empty', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: { text: '' },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toBeNull();
    expect(out.recovered).toBe(false);
  });

  it('returns parsed:null when there is an unbalanced brace', async () => {
    const out = (await callTool({
      name: 'parse.json',
      input: { text: '{"missing": "close"' },
      mode: MODE,
    })) as { parsed: unknown; recovered: boolean };
    expect(out.parsed).toBeNull();
    expect(out.recovered).toBe(false);
  });
});

describe('parse.json — determinism', () => {
  it('mock returns the same output for the same input across 25 calls', async () => {
    const text = 'pre ```json\n{"x":[1,2,3]}\n``` post';
    const first = JSON.stringify(
      await callTool({ name: 'parse.json', input: { text }, mode: MODE }),
    );
    for (let i = 0; i < 24; i++) {
      const o = JSON.stringify(
        await callTool({ name: 'parse.json', input: { text }, mode: MODE }),
      );
      expect(o).toBe(first);
    }
  });
});

describe('parse.json — examples parse against schemas', () => {
  it('every example input parses against input_schema', () => {
    for (const ex of PARSE_JSON.examples) {
      expect(PARSE_JSON.input_schema.safeParse(ex.input).success).toBe(true);
    }
  });

  it('every example output parses against output_schema', () => {
    for (const ex of PARSE_JSON.examples) {
      expect(PARSE_JSON.output_schema.safeParse(ex.output).success).toBe(true);
    }
  });
});
