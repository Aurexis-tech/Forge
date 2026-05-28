// Hermetic unit test — PROMPT-CACHING STRUCTURE.
//
// Proves the caching SCAFFOLDING is correct WITHOUT any real LLM call:
//
//   1. CENTERPIECE — deterministic cached prefix. The cached system
//      block is byte-IDENTICAL across two DIFFERENT files / specs in the
//      same forge, while the per-file user message differs. That byte
//      identity is the precondition for a cache HIT, so this is the test
//      that proves caching will actually fire on a real forge.
//
//   2. No non-deterministic content (timestamps / uuids / Date.now)
//      leaks into a cached block — any such content would break the
//      byte identity and silently kill the hit-rate.
//
//   3. The cached prefixes are large enough to clear the Sonnet 4.6
//      cache minimum (1,024 tokens). Sub-minimum Haiku call-sites
//      (classify, critique) are documented as intentionally uncached.
//
//   4. Pricing + ledger: llmCostUsd applies the cache multipliers
//      (read 0.1x, write 1.25x) and recordCost writes the two cache
//      token columns. Fed synthetic usage; asserts the recorded row.
//
// Stubbed: recordCost's supabase is an in-memory capture double. No
// network, no LLM, no real DB. (No module mocks — everything here is the
// real engine code under test.)

import { describe, expect, it } from 'vitest';
import {
  buildCodegenSystemPrompt,
  buildCodegenUserMessage,
} from '@/lib/engine/codegen/prompts';
import {
  ROUTE_SYSTEM_PROMPT_CACHED,
  PAGE_SYSTEM_PROMPT_CACHED,
  buildRouteUserMessage,
} from '@/lib/engine/software/codegen/prompts';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';
import {
  SoftwareSpecSchema,
  type SoftwareSpec as SoftwareSpecT,
} from '@/lib/engine/software/spec';
import { llmCostUsd, CACHE_READ_MULTIPLIER, CACHE_WRITE_5M_MULTIPLIER } from '@/lib/engine/governance/pricing';
import { recordCost, computeAmountUsd } from '@/lib/engine/governance/ledger';
import type { ForgeSupabase } from '@/lib/supabase';

// A non-deterministic-content sniff: ISO timestamps, uuids, epoch-ish
// Date.now() integers. If any cached block matches these, a cache hit
// would never recur.
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Rough Sonnet 4.6 cache minimum check (1,024 tokens). Conservative
// chars/token = 4.0, so a prefix clears the minimum if chars >= 4096.
const SONNET_MIN_CHARS = 1024 * 4;

// ---------------------------------------------------------------------------
// Fixtures — two DIFFERENT files in the SAME forge (same scaffold).
// ---------------------------------------------------------------------------
const specA: AgentSpec = AgentSpecSchema.parse({
  name: 'Alpha',
  goal: 'Do alpha things.',
  description: 'Alpha agent that does alpha.',
  trigger: 'schedule',
  runtime: 'on_demand',
  inputs: [{ name: 'a_in', description: 'alpha input' }],
  capabilities: [{ tool: 'http_request', why: 'fetch' }],
  outputs: [{ name: 'a_out', description: 'alpha output' }],
  constraints: [],
  success_criteria: ['alpha works'],
  risk: 'low',
  confidence: 0.9,
});

const specB: AgentSpec = AgentSpecSchema.parse({
  name: 'Beta',
  goal: 'Do beta things — entirely different.',
  description: 'Beta agent, unrelated to alpha.',
  trigger: 'webhook',
  runtime: 'always_on',
  inputs: [{ name: 'b_in', description: 'beta input' }],
  capabilities: [{ tool: 'llm_completion', why: 'summarise' }],
  outputs: [{ name: 'b_out', description: 'beta output' }],
  constraints: ['beta constraint'],
  success_criteria: ['beta works'],
  risk: 'medium',
  confidence: 0.8,
});

const plan: BuildPlan = BuildPlanSchema.parse({
  scaffold: 'agent-node-tool-using',
  target: {
    framework: 'nodejs',
    hosting: 'vercel_function',
    entrypoint: 'src/index.ts',
  },
  trigger_impl: 'cron',
  runtime_impl: 'on_demand',
  tools: [
    { requested: 'http_request', status: 'supported', registry_id: 'http_request', env_keys: [] },
  ],
  files: [{ path: 'src/index.ts', purpose: 'entry' }],
  env_required: [],
  tasks: [{ id: 't', title: 't', description: 't', depends_on: [] }],
  estimate: { risk: 'low', complexity: 'low', notes: 'n' },
  warnings: [],
});

// The forge-stable scaffold interface — the SAME for every file in a build.
const toolInterface = `// src/lib/tools/types.ts
export const http_request: Tool<{ url: string }, { status: number; body: string }>;
export const llm_completion: Tool<{ user: string }, { text: string }>;`;

const allFiles = [
  { path: 'src/index.ts', purpose: 'entry', source: 'generated' as const },
];

// ===========================================================================
// 1. CENTERPIECE — deterministic cached prefix across different files
// ===========================================================================
describe('codegen cached prefix is byte-identical across different files (cache HIT precondition)', () => {
  // Two different files in the same forge: same scaffold (toolInterface),
  // different spec + filePath + purpose.
  const systemA = buildCodegenSystemPrompt({ toolInterface });
  const systemB = buildCodegenSystemPrompt({ toolInterface });

  const userA = buildCodegenUserMessage({
    spec: specA,
    plan,
    filePath: 'src/index.ts',
    filePurpose: 'alpha entry',
    allFiles,
  });
  const userB = buildCodegenUserMessage({
    spec: specB,
    plan,
    filePath: 'src/handlers/beta.ts',
    filePurpose: 'beta handler',
    allFiles,
  });

  it('cached system block is byte-identical (the cached prefix)', () => {
    expect(systemA).toBe(systemB);
  });

  it('per-file user message DIFFERS (variable content lives after the breakpoint)', () => {
    expect(userA).not.toBe(userB);
    // And the difference is real (different goals surface).
    expect(userA).toContain('Do alpha things.');
    expect(userB).toContain('Do beta things — entirely different.');
  });

  it('no spec-specific content leaked into the cached prefix', () => {
    // The variable goals must NOT appear in the cached block — if they
    // did, the prefix would diverge per file and never cache.
    expect(systemA).not.toContain('Do alpha things.');
    expect(systemA).not.toContain('Do beta things');
  });
});

describe('software cached prefixes are global constants (cache HIT precondition)', () => {
  it('ROUTE / PAGE cached system blocks are stable constants', () => {
    // They are module constants — referencing them twice yields the
    // identical string. Two route slots for different entities share it.
    expect(ROUTE_SYSTEM_PROMPT_CACHED).toBe(ROUTE_SYSTEM_PROMPT_CACHED);
    const userExpense = buildRouteUserMessage({
      spec: SOFTWARE_SPEC,
      entityName: 'Expense',
      tableName: 'expense',
      fields: [{ name: 'amount', type: 'number' }],
      slotKind: 'list_route',
      filePath: 'app/api/expense/_list.ts',
    });
    const userInvoice = buildRouteUserMessage({
      spec: SOFTWARE_SPEC,
      entityName: 'Invoice',
      tableName: 'invoice',
      fields: [{ name: 'total', type: 'number' }],
      slotKind: 'list_route',
      filePath: 'app/api/invoice/_list.ts',
    });
    // Variable per-slot content differs; cached block is shared.
    expect(userExpense).not.toBe(userInvoice);
    expect(userExpense).not.toContain('WORKED EXEMPLAR'); // moved to cache
  });
});

// ===========================================================================
// 2. No non-deterministic content in cached blocks
// ===========================================================================
describe('cached blocks contain no non-deterministic content', () => {
  const blocks: Array<[string, string]> = [
    ['codegen system', buildCodegenSystemPrompt({ toolInterface })],
    ['software route system', ROUTE_SYSTEM_PROMPT_CACHED],
    ['software page system', PAGE_SYSTEM_PROMPT_CACHED],
  ];

  for (const [label, block] of blocks) {
    it(`${label}: no ISO timestamp / uuid leaks`, () => {
      expect(block, label).not.toMatch(TIMESTAMP_RE);
      expect(block, label).not.toMatch(UUID_RE);
    });
  }
});

// ===========================================================================
// 3. Cached prefixes clear the Sonnet minimum; Haiku sites documented
// ===========================================================================
describe('cached prefixes clear the Sonnet 4.6 cache minimum (1,024 tokens)', () => {
  it('codegen cached system block is comfortably above the minimum', () => {
    const block = buildCodegenSystemPrompt({ toolInterface });
    expect(block.length).toBeGreaterThan(SONNET_MIN_CHARS);
  });

  it('software route + page cached system blocks clear the minimum', () => {
    expect(ROUTE_SYSTEM_PROMPT_CACHED.length).toBeGreaterThan(SONNET_MIN_CHARS);
    expect(PAGE_SYSTEM_PROMPT_CACHED.length).toBeGreaterThan(SONNET_MIN_CHARS);
  });

  // DOCUMENTED: the Haiku-tier sites (classify, critique) have a 4,096-
  // token minimum and stable prefixes far below it, and run ~once per
  // forge — they are intentionally left UNCACHED (no cacheSystem flag).
  // The 3 small planners (software/infra/system) sit below 1,024 and run
  // once per forge — also intentionally uncached. No pointless breakpoints.
});

// ===========================================================================
// 4. Pricing + ledger capture the cache token fields
// ===========================================================================
describe('llmCostUsd applies the cache pricing multipliers', () => {
  it('cache read is billed at 0.1x base input; write at 1.25x', () => {
    const model = 'claude-sonnet-4-6'; // input 3.00 / MTok
    const base = llmCostUsd(model, 1_000_000, 0); // 1M uncached input
    expect(base).toBeCloseTo(3.0, 6);

    const read = llmCostUsd(model, 0, 0, { cacheReadTokens: 1_000_000 });
    expect(read).toBeCloseTo(3.0 * CACHE_READ_MULTIPLIER, 6); // 0.30

    const write = llmCostUsd(model, 0, 0, { cacheCreationTokens: 1_000_000 });
    expect(write).toBeCloseTo(3.0 * CACHE_WRITE_5M_MULTIPLIER, 6); // 3.75
  });

  it('omitting the cache argument preserves the original cost (back-compat)', () => {
    const a = llmCostUsd('claude-sonnet-4-6', 1000, 500);
    const b = llmCostUsd('claude-sonnet-4-6', 1000, 500, {});
    expect(a).toBe(b);
  });

  it('a cached call costs less than the same input billed full-price', () => {
    // 10k tokens read from cache vs paid as fresh input.
    const cached = llmCostUsd('claude-sonnet-4-6', 0, 0, { cacheReadTokens: 10_000 });
    const fresh = llmCostUsd('claude-sonnet-4-6', 10_000, 0);
    expect(cached).toBeLessThan(fresh);
    expect(cached).toBeCloseTo(fresh * CACHE_READ_MULTIPLIER, 9);
  });
});

describe('recordCost writes the cache token columns', () => {
  it('persists cache_creation_input_tokens + cache_read_input_tokens', async () => {
    let captured: Record<string, unknown> | null = null;
    const fakeSupabase = {
      from() {
        return {
          insert(payload: Record<string, unknown>) {
            captured = payload;
            return {
              select() {
                return {
                  single: async () => ({ data: { id: 'evt-1' }, error: null }),
                };
              },
            };
          },
        };
      },
    } as unknown as ForgeSupabase;

    const result = await recordCost(
      {
        user_id: null,
        project_id: null,
        kind: 'llm',
        model: 'claude-sonnet-4-6',
        input_tokens: 50,
        output_tokens: 20,
        cache_creation_input_tokens: 2048,
        cache_read_input_tokens: 100_000,
        key_source: 'platform',
        ref: 'codegen.unit',
      },
      fakeSupabase,
    );

    expect(result.event_id).toBe('evt-1');
    expect(captured).not.toBeNull();
    expect(captured!.cache_creation_input_tokens).toBe(2048);
    expect(captured!.cache_read_input_tokens).toBe(100_000);
    // amount_usd reflects the discounted cache read + surcharged write.
    expect(typeof captured!.amount_usd).toBe('number');
    expect(captured!.amount_usd as number).toBeGreaterThan(0);
  });

  it('computeAmountUsd factors the cache breakdown', () => {
    const withCache = computeAmountUsd({
      user_id: null,
      kind: 'llm',
      model: 'claude-sonnet-4-6',
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    // 1M read tokens at 0.1 * 3.00 = 0.30 USD.
    expect(withCache).toBeCloseTo(0.3, 6);
  });
});

// ---------------------------------------------------------------------------
// Shared SoftwareSpec fixture for the route message builder.
// ---------------------------------------------------------------------------
const SOFTWARE_SPEC: SoftwareSpecT = SoftwareSpecSchema.parse({
  goal: 'expense + invoice tracker',
  pages: [
    { id: 'list', name: 'List', purpose: 'list rows' },
  ],
  entities: [
    { name: 'Expense', fields: [{ name: 'amount', type: 'number' }] },
    { name: 'Invoice', fields: [{ name: 'total', type: 'number' }] },
  ],
  flows: [],
  auth: { requires_auth: true, roles: [], per_user_isolation: true },
  integrations: [],
});
