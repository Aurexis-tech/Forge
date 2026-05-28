// Per-tool test — compute_text_transform seed tool.

import { describe, expect, it } from 'vitest';
import { callTool, COMPUTE_TEXT_TRANSFORM } from '@/lib/engine/tools';

const MODE = 'mock' as const;

async function transform(
  text: string,
  op: string,
  params?: Record<string, unknown>,
): Promise<string> {
  const out = (await callTool({
    name: 'compute_text_transform',
    input: { text, op, params },
    mode: MODE,
  })) as { result: string };
  return out.result;
}

describe('compute_text_transform — slug', () => {
  it('lowercases + collapses non-alnum runs to single dashes', async () => {
    expect(await transform('Hello World!', 'slug')).toBe('hello-world');
  });

  it("strips ASCII + smart apostrophes; strips diacritics via NFKD", async () => {
    expect(await transform("O'Reilly's Café  & Co.", 'slug')).toBe('oreillys-cafe-co');
  });

  it('strips leading + trailing punctuation', async () => {
    expect(await transform('--leading-and-trailing--', 'slug')).toBe('leading-and-trailing');
  });
});

describe('compute_text_transform — kebab + snake + title', () => {
  it('kebab joins lowercased words with single dashes', async () => {
    expect(await transform('Hello World From Forge', 'kebab')).toBe('hello-world-from-forge');
  });

  it('snake joins lowercased words with single underscores', async () => {
    expect(await transform('Hello World', 'snake')).toBe('hello_world');
  });

  it('title capitalises first letter of every word', async () => {
    expect(await transform('hello world from the forge', 'title')).toBe(
      'Hello World From The Forge',
    );
  });

  it('title preserves already-capitalised words by lowering the tail', async () => {
    expect(await transform('HELLO WORLD', 'title')).toBe('Hello World');
  });
});

describe('compute_text_transform — truncate', () => {
  it('truncates with default suffix "…" at default length 80', async () => {
    const text = 'x'.repeat(100);
    const out = await transform(text, 'truncate');
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('truncates to a custom length + suffix', async () => {
    expect(
      await transform('The quick brown fox jumps over the lazy dog', 'truncate', {
        max_length: 20,
        suffix: '...',
      }),
    ).toBe('The quick brown f...');
  });

  it('returns the original string when it is already short enough', async () => {
    expect(await transform('hello', 'truncate', { max_length: 80 })).toBe('hello');
  });
});

describe('compute_text_transform — normalize_whitespace', () => {
  it('collapses runs of whitespace + trims', async () => {
    expect(await transform('  hello   world\n\t!  ', 'normalize_whitespace')).toBe(
      'hello world !',
    );
  });

  it('returns empty string for whitespace-only input', async () => {
    expect(await transform('   \t\n  ', 'normalize_whitespace')).toBe('');
  });
});

describe('compute_text_transform — edge cases', () => {
  it('rejects unknown op at the schema boundary', async () => {
    await expect(
      callTool({
        name: 'compute_text_transform',
        input: { text: 'x', op: 'unknown_op' },
        mode: MODE,
      }),
    ).rejects.toThrow(/input/);
  });

  it('rejects non-string text at the schema boundary', async () => {
    await expect(
      callTool({
        name: 'compute_text_transform',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: { text: 42 as any, op: 'slug' },
        mode: MODE,
      }),
    ).rejects.toThrow(/input/);
  });

  it('handles empty text gracefully', async () => {
    expect(await transform('', 'slug')).toBe('');
    expect(await transform('', 'kebab')).toBe('');
    expect(await transform('', 'normalize_whitespace')).toBe('');
  });
});

describe('compute_text_transform — determinism', () => {
  it('mock returns the same output for the same input across 25 calls', async () => {
    const inputs = [
      ['Hello World!', 'slug'],
      ['hello world', 'title'],
      ['  pad  me ', 'normalize_whitespace'],
    ] as const;
    for (const [text, op] of inputs) {
      const first = await transform(text, op);
      for (let i = 0; i < 24; i++) {
        expect(await transform(text, op)).toBe(first);
      }
    }
  });
});

describe('compute_text_transform — examples parse against schemas', () => {
  it('every example input parses against input_schema', () => {
    for (const ex of COMPUTE_TEXT_TRANSFORM.examples) {
      expect(
        COMPUTE_TEXT_TRANSFORM.input_schema.safeParse(ex.input).success,
      ).toBe(true);
    }
  });

  it('every example output parses against output_schema', () => {
    for (const ex of COMPUTE_TEXT_TRANSFORM.examples) {
      expect(
        COMPUTE_TEXT_TRANSFORM.output_schema.safeParse(ex.output).success,
      ).toBe(true);
    }
  });
});
