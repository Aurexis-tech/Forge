// Unit test: SystemSpec Zod schema (Phase 2 intake).
//
// Covers the schema-level invariants from the brief:
//   - accepts a valid spec
//   - rejects self-edges
//   - rejects edges to non-existent ids
//   - rejects a 'dag' pattern with no edges
//   - enforces max_steps default (25) + hard cap (100)
//
// The default + hard-cap rules live entirely in the schema so they
// can't drift from runtime checks.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_STEPS,
  HARD_CAP_MAX_STEPS,
  SystemSpecSchema,
} from '@/lib/engine/system/spec';

const baseAgents = [
  {
    id: 'scraper',
    role: 'scraper',
    description: 'pulls fresh items from a feed',
    inputs: ['url'],
    outputs: ['raw_items'],
  },
  {
    id: 'summarizer',
    role: 'summarizer',
    description: 'reduces raw items to a short brief',
    inputs: ['raw_items'],
    outputs: ['summary'],
  },
  {
    id: 'emailer',
    role: 'emailer',
    description: 'sends the brief to the user',
    inputs: ['summary'],
    outputs: ['delivery_receipt'],
  },
] as const;

const baseSpec = {
  goal: 'A daily news brief delivered to my inbox.',
  sub_agents: baseAgents,
  coordination: {
    pattern: 'pipeline' as const,
  },
  triggers: ['schedule'] as const,
  // max_steps deliberately omitted so the default applies.
};

describe('SystemSpecSchema', () => {
  it('accepts a valid 3-node pipeline', () => {
    const parsed = SystemSpecSchema.safeParse(baseSpec);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Default max_steps gets applied.
      expect(parsed.data.max_steps).toBe(DEFAULT_MAX_STEPS);
      // Pattern + counts preserved.
      expect(parsed.data.coordination.pattern).toBe('pipeline');
      expect(parsed.data.sub_agents).toHaveLength(3);
    }
  });

  it("rejects a 'dag' coordination with no edges", () => {
    const spec = {
      ...baseSpec,
      coordination: { pattern: 'dag', edges: [] },
    };
    const parsed = SystemSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.message.includes("'dag' requires explicit edges"),
        ),
      ).toBe(true);
    }
  });

  it('rejects a self-edge', () => {
    const spec = {
      ...baseSpec,
      coordination: {
        pattern: 'dag',
        edges: [
          { from: 'scraper', to: 'summarizer' },
          { from: 'summarizer', to: 'summarizer' },
          { from: 'summarizer', to: 'emailer' },
        ],
      },
    };
    const parsed = SystemSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.message.includes('self-edges'),
        ),
      ).toBe(true);
    }
  });

  it('rejects an edge that references a non-existent sub_agent id', () => {
    const spec = {
      ...baseSpec,
      coordination: {
        pattern: 'dag',
        edges: [
          { from: 'scraper', to: 'summarizer' },
          { from: 'summarizer', to: 'ghost' }, // ghost is not declared
        ],
      },
    };
    const parsed = SystemSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.message.includes("'ghost' does not match any sub_agent id"),
        ),
      ).toBe(true);
    }
  });

  it('rejects duplicate sub_agent ids', () => {
    const spec = {
      ...baseSpec,
      sub_agents: [
        baseAgents[0],
        { ...baseAgents[1], id: 'scraper' }, // duplicate id
        baseAgents[2],
      ],
    };
    const parsed = SystemSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.message.includes('duplicate sub_agent id'),
        ),
      ).toBe(true);
    }
  });

  it('accepts an explicit max_steps within the hard cap', () => {
    const parsed = SystemSpecSchema.safeParse({ ...baseSpec, max_steps: 80 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.max_steps).toBe(80);
  });

  it('rejects max_steps > HARD_CAP_MAX_STEPS', () => {
    // HARD_CAP_MAX_STEPS is the schema-enforced ceiling; anything higher
    // must be refused regardless of what the user requested.
    const parsed = SystemSpecSchema.safeParse({
      ...baseSpec,
      max_steps: HARD_CAP_MAX_STEPS + 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.message.includes('max_steps cannot exceed ' + HARD_CAP_MAX_STEPS),
        ),
      ).toBe(true);
    }
  });

  it('rejects fewer than 2 sub_agents (single-agent should use AgentSpec)', () => {
    const parsed = SystemSpecSchema.safeParse({
      ...baseSpec,
      sub_agents: [baseAgents[0]],
    });
    expect(parsed.success).toBe(false);
  });
});
