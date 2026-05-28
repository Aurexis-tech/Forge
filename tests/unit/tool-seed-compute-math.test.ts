// Per-tool test — compute_math seed tool.

import { describe, expect, it } from 'vitest';
import { callTool, COMPUTE_MATH } from '@/lib/engine/tools';

const MODE = 'mock' as const;

describe('compute_math — happy path', () => {
  it('evaluates simple arithmetic', async () => {
    const out = (await callTool({
      name: 'compute_math',
      input: { expression: '2 + 3' },
      mode: MODE,
    })) as { value: number };
    expect(out.value).toBe(5);
  });

  it('evaluates a function + constant expression', async () => {
    const out = (await callTool({
      name: 'compute_math',
      input: { expression: 'sqrt(16) + 1' },
      mode: MODE,
    })) as { value: number };
    expect(out.value).toBe(5);
  });

  it('handles pi correctly', async () => {
    const out = (await callTool({
      name: 'compute_math',
      input: { expression: 'pi' },
      mode: MODE,
    })) as { value: number };
    expect(out.value).toBeCloseTo(Math.PI, 12);
  });
});

describe('compute_math — edge cases', () => {
  it('returns an error message for malformed input rather than throwing', async () => {
    const out = (await callTool({
      name: 'compute_math',
      input: { expression: '2 +' },
      mode: MODE,
    })) as { value: number | string; error?: string };
    expect(out.error).toBeDefined();
    expect(typeof out.error).toBe('string');
    expect(out.error!.length).toBeGreaterThan(0);
  });

  it('coerces non-finite results to a string + sets error', async () => {
    const out = (await callTool({
      name: 'compute_math',
      input: { expression: '1 / 0' },
      mode: MODE,
    })) as { value: number | string; error?: string };
    // Either non-finite-handling kicks in OR mathjs throws. Both
    // paths must produce a non-empty error.
    if (typeof out.value === 'number') {
      // mathjs returns Infinity → normalised to 'Infinity' + error.
      expect(true).toBe(false); // should not happen, but allow fall-through
    } else {
      expect(out.error).toBeDefined();
    }
  });

  it('rejects empty expression at the schema boundary', async () => {
    await expect(
      callTool({ name: 'compute_math', input: { expression: '' }, mode: MODE }),
    ).rejects.toThrow(/input/);
  });
});

describe('compute_math — determinism', () => {
  it('mock returns the same output for the same input across 50 calls', async () => {
    const outputs = await Promise.all(
      Array.from({ length: 50 }, () =>
        callTool({
          name: 'compute_math',
          input: { expression: 'sin(pi/2) + cos(0)' },
          mode: MODE,
        }),
      ),
    );
    const first = JSON.stringify(outputs[0]);
    for (const o of outputs) {
      expect(JSON.stringify(o)).toBe(first);
    }
  });
});

describe('compute_math — examples parse against schemas', () => {
  it('every example input parses against input_schema', () => {
    for (const ex of COMPUTE_MATH.examples) {
      expect(COMPUTE_MATH.input_schema.safeParse(ex.input).success).toBe(true);
    }
  });

  it('every example output parses against output_schema', () => {
    for (const ex of COMPUTE_MATH.examples) {
      expect(COMPUTE_MATH.output_schema.safeParse(ex.output).success).toBe(true);
    }
  });
});
