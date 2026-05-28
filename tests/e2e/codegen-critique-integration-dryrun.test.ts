// Hermetic integration test — the CRITIQUE-REFINE gate WIRING.
//
// Tests the integration points (NOT the helper logic — that's
// covered by tests/unit/codegen-critique.test.ts):
//
//   - generateOneAgentFile (agents + systems-via-reuse): when the
//     flag is on, after pass-1 static-check passes, the critique
//     LLM is invoked with the right governance ref. Low score →
//     refine fires with the right ref. The final content reflects
//     the chosen path.
//
//   - The existing pass-1 / repair flow is UNTOUCHED with the flag
//     off (default) — every existing codegen dry-run already
//     verifies this; we add one more direct check here.
//
// Mocks: `complete()` (returns scripted canned responses) +
// `staticCheckFile` (returns ok). Both are at the engine seam, so
// the gate's plumbing exercises real prompt + governance threading.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the LLM + static checker BEFORE importing the generator so
// the generator picks up our mocks.
vi.mock('@/lib/engine/llm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/engine/llm')>(
    '@/lib/engine/llm',
  );
  return { ...actual, complete: vi.fn() };
});
vi.mock('@/lib/engine/codegen/staticcheck', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/engine/codegen/staticcheck')
  >('@/lib/engine/codegen/staticcheck');
  return { ...actual, staticCheckFile: vi.fn() };
});

import {
  generateOneAgentFile,
  type GenerateOneAgentFileArgs,
} from '@/lib/engine/codegen/generate';
import { complete } from '@/lib/engine/llm';
import { staticCheckFile } from '@/lib/engine/codegen/staticcheck';
import { AgentSpecSchema, type AgentSpec } from '@/lib/engine/spec/schema';
import { BuildPlanSchema, type BuildPlan } from '@/lib/engine/planner/schema';
import { QUALITY_BAR } from '@/lib/engine/codegen/quality';

const completeMock = complete as unknown as ReturnType<typeof vi.fn>;
const staticCheckMock = staticCheckFile as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures — minimal but schema-valid spec + plan.
// ---------------------------------------------------------------------------
const sampleSpec: AgentSpec = AgentSpecSchema.parse({
  name: 'Daily Watch',
  goal: 'Notify when a URL changes.',
  description: 'Schedule fetch and compare.',
  trigger: 'schedule',
  runtime: 'on_demand',
  inputs: [{ name: 'watch_url', description: 'URL to monitor.' }],
  capabilities: [{ tool: 'http_request', why: 'Fetch the page.' }],
  outputs: [{ name: 'brief', description: 'Change summary.' }],
  constraints: ['One request per run.'],
  success_criteria: ['Brief delivered before 9am.'],
  risk: 'low',
  confidence: 0.9,
});

const samplePlan: BuildPlan = BuildPlanSchema.parse({
  scaffold: 'agent-node-tool-using',
  target: {
    framework: 'nodejs',
    hosting: 'vercel_function',
    entrypoint: 'src/index.ts',
  },
  trigger_impl: 'Vercel cron.',
  runtime_impl: 'on_demand',
  tools: [
    {
      requested: 'http_request',
      status: 'supported',
      registry_id: 'http_request',
      env_keys: [],
    },
  ],
  files: [{ path: 'src/index.ts', purpose: 'Entrypoint.' }],
  env_required: [],
  tasks: [
    {
      id: 'fetch',
      title: 'Fetch the URL',
      description: 'GET the URL.',
      depends_on: [],
    },
  ],
  estimate: { risk: 'low', complexity: 'low', notes: 'small' },
  warnings: [],
});

const baseArgs: GenerateOneAgentFileArgs = {
  spec: sampleSpec,
  plan: samplePlan,
  toolInterface: 'export const http_request: unknown;',
  filePath: 'src/index.ts',
  filePurpose: 'Entrypoint that runs one watch cycle.',
  allFiles: [
    {
      path: 'src/index.ts',
      purpose: 'Entrypoint',
      source: 'generated' as const,
    },
  ],
  governance: {
    user_id: 'u',
    project_id: 'p',
    ref: 'codegen.test',
  },
};

function critiqueReplyAllMet(overall: number): string {
  return JSON.stringify({
    criteria: QUALITY_BAR.map((c) => ({
      id: c.id,
      met: overall >= 4,
      score: overall,
      note: '',
    })),
    overall_score: overall,
    suggestions: [],
  });
}

const PASS1_CODE = 'export const handler = async () => 1;\n';
const REFINED_CODE = 'export const handler = async () => 2;\n';

beforeEach(() => {
  completeMock.mockReset();
  staticCheckMock.mockReset();
  // Default: every static check passes.
  staticCheckMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete process.env.CRITIQUE_GATE_ENABLED;
});

// ===========================================================================
// FLAG OFF — wiring is inert
// ===========================================================================
describe('generateOneAgentFile — critique gate flag OFF (default)', () => {
  it('issues ONLY the pass-1 codegen call; no critique, no refine', async () => {
    // pass-1 returns clean code
    completeMock.mockResolvedValueOnce({
      text: PASS1_CODE,
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });
    const out = await generateOneAgentFile(baseArgs);
    expect(out.content.trim()).toBe(PASS1_CODE.trim());
    expect(out.attempts).toBe(1);
    expect(out.staticCheck.ok).toBe(true);
    expect(completeMock).toHaveBeenCalledTimes(1);
    // The single call should be the pass-1 with ref ending .pass1
    const call = completeMock.mock.calls[0]?.[0];
    expect(call?.governance?.ref).toMatch(/\.pass1$/);
  });
});

// ===========================================================================
// FLAG ON — critique fires
// ===========================================================================
describe('generateOneAgentFile — critique gate flag ON', () => {
  beforeEach(() => {
    process.env.CRITIQUE_GATE_ENABLED = 'true';
  });

  it('issues codegen + critique; high score → keeps original', async () => {
    completeMock
      // pass-1 codegen
      .mockResolvedValueOnce({
        text: PASS1_CODE,
        usage: { input_tokens: 100, output_tokens: 100 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      })
      // critique → high score, all met
      .mockResolvedValueOnce({
        text: critiqueReplyAllMet(5),
        usage: { input_tokens: 50, output_tokens: 50 },
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
      });
    const out = await generateOneAgentFile(baseArgs);
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(out.content.trim()).toBe(PASS1_CODE.trim());
    const refs = completeMock.mock.calls.map(
      (c) => (c[0] as { governance?: { ref?: string } }).governance?.ref ?? '',
    );
    expect(refs[0]).toMatch(/\.pass1$/);
    expect(refs[1]).toMatch(/\.critique$/);
  });

  it('codegen + critique + refine; low score → uses refined output', async () => {
    completeMock
      // pass-1 codegen
      .mockResolvedValueOnce({
        text: PASS1_CODE,
        usage: { input_tokens: 100, output_tokens: 100 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      })
      // critique → low score
      .mockResolvedValueOnce({
        text: critiqueReplyAllMet(2),
        usage: { input_tokens: 50, output_tokens: 50 },
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
      })
      // refine → improved code
      .mockResolvedValueOnce({
        text: REFINED_CODE,
        usage: { input_tokens: 200, output_tokens: 200 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      });
    const out = await generateOneAgentFile(baseArgs);
    expect(completeMock).toHaveBeenCalledTimes(3);
    // The final content is the refined version.
    expect(out.content.trim()).toBe(REFINED_CODE.trim());
    const refs = completeMock.mock.calls.map(
      (c) => (c[0] as { governance?: { ref?: string } }).governance?.ref ?? '',
    );
    expect(refs[0]).toMatch(/\.pass1$/);
    expect(refs[1]).toMatch(/\.critique$/);
    expect(refs[2]).toMatch(/\.refine$/);
  });

  it('hard cap = 1 refine — even with a 1/5 score, refine is called once', async () => {
    completeMock
      .mockResolvedValueOnce({
        text: PASS1_CODE,
        usage: { input_tokens: 100, output_tokens: 100 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      })
      .mockResolvedValueOnce({
        text: critiqueReplyAllMet(1),
        usage: { input_tokens: 50, output_tokens: 50 },
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
      })
      .mockResolvedValueOnce({
        text: REFINED_CODE,
        usage: { input_tokens: 200, output_tokens: 200 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      });
    await generateOneAgentFile(baseArgs);
    expect(completeMock).toHaveBeenCalledTimes(3); // pass1 + critique + 1×refine
  });

  it('refined output fails static-check → falls back to original', async () => {
    completeMock
      .mockResolvedValueOnce({
        text: PASS1_CODE,
        usage: { input_tokens: 100, output_tokens: 100 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      })
      .mockResolvedValueOnce({
        text: critiqueReplyAllMet(2),
        usage: { input_tokens: 50, output_tokens: 50 },
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
      })
      .mockResolvedValueOnce({
        text: 'broken refined code',
        usage: { input_tokens: 200, output_tokens: 200 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      });
    staticCheckMock
      .mockResolvedValueOnce({ ok: true }) // pass-1 check
      .mockResolvedValueOnce({ ok: false, error: 'syntax' }); // refined check
    const out = await generateOneAgentFile(baseArgs);
    // Falls back to the ORIGINAL pass-1 code.
    expect(out.content.trim()).toBe(PASS1_CODE.trim());
    // Output's recorded static-check is from pass-1 (clean).
    expect(out.staticCheck.ok).toBe(true);
  });

  it('wires the per-file audit hooks through GenerateOneAgentFileArgs', async () => {
    const started = vi.fn();
    const completed = vi.fn();
    const refineTriggered = vi.fn();
    completeMock
      .mockResolvedValueOnce({
        text: PASS1_CODE,
        usage: { input_tokens: 100, output_tokens: 100 },
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      })
      .mockResolvedValueOnce({
        text: critiqueReplyAllMet(5),
        usage: { input_tokens: 50, output_tokens: 50 },
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
      });
    await generateOneAgentFile({
      ...baseArgs,
      critiqueAudit: {
        critiqueStarted: started,
        critiqueCompleted: completed,
        refineTriggered,
      },
    });
    expect(started).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(refineTriggered).not.toHaveBeenCalled(); // high score; no refine
  });
});

// ===========================================================================
// HERMETICITY
// ===========================================================================
describe('codegen-critique integration hermeticity', () => {
  it('no real fetch was issued', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
