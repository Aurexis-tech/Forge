// Hermetic unit test — the CRITIQUE-AND-REFINE gate.
//
// Tests the engine-owned `critiqueAndRefine` helper directly:
//
//   - Flag-OFF (default) → no-op passthrough; zero LLM calls; the
//     refine seam is never invoked.
//   - Flag-ON + high-score critique → original kept; zero refine
//     calls; critique LLM called exactly once.
//   - Flag-ON + low-score critique → refine triggered; refined code
//     used when it passes static-check.
//   - Flag-ON + low-score + refined fails static-check → falls
//     back to original; audit emits 'static_check_failed'.
//   - Flag-ON + low-score + regenerate throws → falls back to
//     original; audit emits 'regenerate_error'.
//   - Threshold edge: overall_score === threshold AND all met →
//     no refine; one below → refine fires.
//   - Audit hooks fire in the right order with the right meta.
//
// Stubbed: `complete()` (LLM) + `staticCheckFile` (for refined
// outputs). Real things that run: the helper, the JSON extractor,
// the env-flag read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GovernanceScope } from '@/lib/engine/llm';

// Mock the LLM seam BEFORE importing the helper so the helper picks
// up our mock when it runs.
vi.mock('@/lib/engine/llm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/engine/llm')>(
    '@/lib/engine/llm',
  );
  return {
    ...actual,
    complete: vi.fn(),
  };
});

// Mock the static checker too so we can control whether refined
// output 'compiles'.
vi.mock('@/lib/engine/codegen/staticcheck', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/engine/codegen/staticcheck')
  >('@/lib/engine/codegen/staticcheck');
  return {
    ...actual,
    staticCheckFile: vi.fn(),
  };
});

import {
  buildRefinementContextMessage,
  critiqueAndRefine,
  isCritiqueGateEnabled,
  getCritiqueThreshold,
  type CritiqueResult,
  type RegenerateForRefine,
} from '@/lib/engine/codegen/critique';
import { complete } from '@/lib/engine/llm';
import { staticCheckFile } from '@/lib/engine/codegen/staticcheck';
import { QUALITY_BAR } from '@/lib/engine/codegen/quality';

const completeMock = complete as unknown as ReturnType<typeof vi.fn>;
const staticCheckMock = staticCheckFile as unknown as ReturnType<typeof vi.fn>;

const baseGovernance: GovernanceScope = {
  user_id: 'test-user',
  project_id: 'test-project',
  ref: 'codegen.test',
};

// Helper: produce a critic JSON reply with given met-everywhere flag
// + overall score. Uses every QUALITY_BAR id so parsing exercises
// the full schema.
function critiqueReply(opts: {
  overall: number;
  allMet: boolean;
  perScore?: number;
  suggestions?: string[];
}): string {
  const score = opts.perScore ?? (opts.allMet ? 5 : 3);
  const criteria = QUALITY_BAR.map((c) => ({
    id: c.id,
    met: opts.allMet,
    score,
    note: 'short note',
  }));
  return JSON.stringify({
    criteria,
    overall_score: opts.overall,
    suggestions: opts.suggestions ?? ['be more concrete', 'validate inputs'],
  });
}

beforeEach(() => {
  completeMock.mockReset();
  staticCheckMock.mockReset();
  // Default static-check for the helper's "refined output" check:
  // OK unless a specific test overrides.
  staticCheckMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  delete process.env.CRITIQUE_GATE_ENABLED;
  delete process.env.CRITIQUE_GATE_THRESHOLD;
});

// ===========================================================================
// FLAG OFF — pure passthrough
// ===========================================================================
describe('critiqueAndRefine — flag off (default)', () => {
  it('returns the original code with decision="skipped" and zero LLM calls', async () => {
    // Default: CRITIQUE_GATE_ENABLED unset.
    expect(isCritiqueGateEnabled()).toBe(false);
    const regen = vi.fn();
    const result = await critiqueAndRefine({
      code: 'export const handler = async () => 1;',
      filePath: 'src/index.ts',
      filePurpose: 'entrypoint',
      regenerate: regen as RegenerateForRefine,
      governance: baseGovernance,
    });
    expect(result.source).toBe('original');
    expect(result.decision).toBe('skipped');
    expect(result.critique).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
    expect(regen).not.toHaveBeenCalled();
    expect(staticCheckMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// FLAG ON — critique pass
// ===========================================================================
describe('critiqueAndRefine — flag on, critique pass', () => {
  beforeEach(() => {
    process.env.CRITIQUE_GATE_ENABLED = 'true';
  });

  it('keeps original when critic returns high score AND all met', async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 5, allMet: true }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn();
    const result = await critiqueAndRefine({
      code: 'export const handler = async () => 1;',
      filePath: 'src/index.ts',
      filePurpose: 'entrypoint',
      regenerate: regen as RegenerateForRefine,
      governance: baseGovernance,
    });
    expect(result.source).toBe('original');
    expect(result.decision).toBe('kept_original');
    expect(result.critique?.passesThreshold).toBe(true);
    expect(completeMock).toHaveBeenCalledTimes(1); // critique only
    expect(regen).not.toHaveBeenCalled();
  });

  it("triggers refine when overall_score is below threshold (default 4)", async () => {
    // overall=3, allMet=false → passesThreshold=false → refine
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 3, allMet: false }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn(async () => 'export const handler = async () => 2;');
    const result = await critiqueAndRefine({
      code: 'export const handler = async () => 1;',
      filePath: 'src/index.ts',
      filePurpose: 'entrypoint',
      regenerate: regen,
      governance: baseGovernance,
    });
    expect(result.source).toBe('refined');
    expect(result.decision).toBe('used_refined');
    expect(result.code).toBe('export const handler = async () => 2;');
    expect(completeMock).toHaveBeenCalledTimes(1); // critique
    expect(regen).toHaveBeenCalledTimes(1); // refine (one round, bounded)
    // The refine governance ref is namespaced.
    const refineCallArgs = (regen.mock.calls as unknown[][])[0]?.[0] as
      | { governance?: { ref?: string } }
      | undefined;
    expect(refineCallArgs?.governance?.ref).toMatch(/\.refine$/);
  });

  it("threshold edge: overall === THRESHOLD AND all met → kept_original", async () => {
    const threshold = getCritiqueThreshold(); // default 4
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: threshold, allMet: true }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn();
    const result = await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: regen as RegenerateForRefine,
      governance: baseGovernance,
    });
    expect(result.decision).toBe('kept_original');
    expect(regen).not.toHaveBeenCalled();
  });

  it("threshold edge: one below threshold → refine fires", async () => {
    const threshold = getCritiqueThreshold();
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: threshold - 1, allMet: true }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn(async () => 'refined');
    const result = await critiqueAndRefine({
      code: 'original',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: regen,
      governance: baseGovernance,
    });
    expect(result.decision).toBe('used_refined');
    expect(regen).toHaveBeenCalledTimes(1);
  });

  it("any criterion not met → refine even when overall_score >= threshold", async () => {
    // overall=5 but one criterion has met=false → passesThreshold=false
    const criteria = QUALITY_BAR.map((c, i) => ({
      id: c.id,
      met: i !== 0,
      score: i === 0 ? 3 : 5,
      note: '',
    }));
    completeMock.mockResolvedValueOnce({
      text: JSON.stringify({
        criteria,
        overall_score: 5,
        suggestions: ['fix #0'],
      }),
      usage: { input_tokens: 50, output_tokens: 50 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn(async () => 'refined');
    const result = await critiqueAndRefine({
      code: 'original',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: regen,
      governance: baseGovernance,
    });
    expect(result.decision).toBe('used_refined');
    expect(regen).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// FLAG ON — refine fallback paths
// ===========================================================================
describe('critiqueAndRefine — refine fallback to original', () => {
  beforeEach(() => {
    process.env.CRITIQUE_GATE_ENABLED = 'true';
  });

  it("when refined output fails static-check, original is kept", async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 2, allMet: false }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    // The refined output fails static-check.
    staticCheckMock.mockResolvedValueOnce({
      ok: false,
      error: 'syntax error in refined output',
    });
    const regen = vi.fn(async () => 'broken refined code');
    const result = await critiqueAndRefine({
      code: 'export const handler = async () => 1;',
      filePath: 'src/index.ts',
      filePurpose: 'entrypoint',
      regenerate: regen,
      governance: baseGovernance,
    });
    expect(result.source).toBe('original');
    expect(result.decision).toBe('fallback_to_original_on_refine_fail');
    expect(result.code).toBe('export const handler = async () => 1;');
    expect(regen).toHaveBeenCalledTimes(1); // one round attempted
  });

  it("when regenerate throws, original is kept", async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 2, allMet: false }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn(async () => {
      throw new Error('regen exploded');
    });
    const result = await critiqueAndRefine({
      code: 'original',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: regen,
      governance: baseGovernance,
    });
    expect(result.source).toBe('original');
    expect(result.decision).toBe('fallback_to_original_on_refine_fail');
    expect(staticCheckMock).not.toHaveBeenCalled(); // we never reach static-check
  });

  it("hard cap = 1 refine round (regenerate called at most once)", async () => {
    // Even with a low score, regenerate is invoked ONCE.
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 1, allMet: false }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn(async () => 'refined v1');
    await critiqueAndRefine({
      code: 'original',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: regen,
      governance: baseGovernance,
    });
    expect(regen).toHaveBeenCalledTimes(1);
    // Critique is called exactly once — no critique-of-critique.
    expect(completeMock).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// AUDIT HOOKS
// ===========================================================================
describe('critiqueAndRefine — audit hooks', () => {
  beforeEach(() => {
    process.env.CRITIQUE_GATE_ENABLED = 'true';
  });

  it('fires started + completed (+ keeps original) when threshold met', async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 5, allMet: true }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const started = vi.fn();
    const completed = vi.fn();
    const refineTriggered = vi.fn();
    const refineUsed = vi.fn();
    const refineRejected = vi.fn();
    await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: vi.fn() as unknown as RegenerateForRefine,
      governance: baseGovernance,
      audit: {
        critiqueStarted: started,
        critiqueCompleted: completed,
        refineTriggered,
        refineUsed,
        refineRejectedFallback: refineRejected,
      },
    });
    expect(started).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(refineTriggered).not.toHaveBeenCalled();
    expect(refineUsed).not.toHaveBeenCalled();
    expect(refineRejected).not.toHaveBeenCalled();
    // critiqueCompleted detail captures the verdict (meta only).
    const ev = completed.mock.calls[0]?.[0];
    expect(ev?.overallScore).toBe(5);
    expect(ev?.passesThreshold).toBe(true);
    expect(ev?.criteriaMet).toBe(QUALITY_BAR.length);
    expect(ev?.criteriaTotal).toBe(QUALITY_BAR.length);
  });

  it('fires refineTriggered + refineUsed when refined output passes', async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 2, allMet: false }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const refineTriggered = vi.fn();
    const refineUsed = vi.fn();
    const refineRejected = vi.fn();
    await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: vi.fn(async () => 'refined'),
      governance: baseGovernance,
      audit: {
        refineTriggered,
        refineUsed,
        refineRejectedFallback: refineRejected,
      },
    });
    expect(refineTriggered).toHaveBeenCalledTimes(1);
    expect(refineUsed).toHaveBeenCalledTimes(1);
    expect(refineRejected).not.toHaveBeenCalled();
  });

  it("fires refineRejectedFallback with 'static_check_failed' when refined fails", async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 2, allMet: false }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    staticCheckMock.mockResolvedValueOnce({ ok: false, error: 'bad' });
    const refineRejected = vi.fn();
    await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: vi.fn(async () => 'broken'),
      governance: baseGovernance,
      audit: { refineRejectedFallback: refineRejected },
    });
    expect(refineRejected).toHaveBeenCalledTimes(1);
    expect(refineRejected.mock.calls[0]?.[0]?.reason).toBe('static_check_failed');
  });

  it("fires refineRejectedFallback with 'regenerate_error' when regen throws", async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 2, allMet: false }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const refineRejected = vi.fn();
    await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: vi.fn(async () => {
        throw new Error('boom');
      }),
      governance: baseGovernance,
      audit: { refineRejectedFallback: refineRejected },
    });
    expect(refineRejected).toHaveBeenCalledTimes(1);
    expect(refineRejected.mock.calls[0]?.[0]?.reason).toBe('regenerate_error');
  });
});

// ===========================================================================
// GOVERNANCE NAMESPACING
// ===========================================================================
describe('critiqueAndRefine — governance refs', () => {
  beforeEach(() => {
    process.env.CRITIQUE_GATE_ENABLED = 'true';
  });

  it("critique LLM call carries ref ending '.critique'", async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 5, allMet: true }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: vi.fn() as unknown as RegenerateForRefine,
      governance: baseGovernance,
    });
    const callArgs = completeMock.mock.calls[0]?.[0];
    expect(callArgs?.governance?.ref).toMatch(/\.critique$/);
  });

  it("refine seam receives ref ending '.refine'", async () => {
    completeMock.mockResolvedValueOnce({
      text: critiqueReply({ overall: 2, allMet: false }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn(async () => 'refined');
    await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: regen,
      governance: baseGovernance,
    });
    const refineArgs = (regen.mock.calls as unknown[][])[0]?.[0] as
      | { governance?: { ref?: string } }
      | undefined;
    expect(refineArgs?.governance?.ref).toMatch(/\.refine$/);
  });
});

// ===========================================================================
// JSON ROBUSTNESS
// ===========================================================================
describe('critiqueAndRefine — robust JSON extraction', () => {
  beforeEach(() => {
    process.env.CRITIQUE_GATE_ENABLED = 'true';
  });

  it('parses a fenced ```json ... ``` reply', async () => {
    completeMock.mockResolvedValueOnce({
      text:
        '```json\n' + critiqueReply({ overall: 5, allMet: true }) + '\n```',
      usage: { input_tokens: 100, output_tokens: 100 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const result = await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: vi.fn() as unknown as RegenerateForRefine,
      governance: baseGovernance,
    });
    expect(result.decision).toBe('kept_original');
  });

  it('produces a neutral verdict that triggers refine on unparseable reply', async () => {
    completeMock.mockResolvedValueOnce({
      text: 'I cannot help with that, sorry.',
      usage: { input_tokens: 50, output_tokens: 50 },
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
    });
    const regen = vi.fn(async () => 'refined');
    const result = await critiqueAndRefine({
      code: 'x',
      filePath: 'src/index.ts',
      filePurpose: 'p',
      regenerate: regen,
      governance: baseGovernance,
    });
    // Neutral score 3 + nothing met → triggers refine.
    expect(result.decision).toBe('used_refined');
    expect(regen).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// REFINEMENT MESSAGE BUILDER
// ===========================================================================
describe('buildRefinementContextMessage', () => {
  it('includes the critic score line per criterion + the previous code', () => {
    const critique: CritiqueResult = {
      overall_score: 3,
      criteria: QUALITY_BAR.map((c) => ({
        id: c.id,
        met: false,
        score: 3,
        note: 'short note for ' + c.id,
      })),
      suggestions: ['be more concrete'],
      modelUsed: 'claude-haiku-4-5',
      passesThreshold: false,
    };
    const previousCode = 'export const x = 1;';
    const msg = buildRefinementContextMessage(critique, previousCode);
    // Every criterion id appears in the rendered message.
    for (const c of QUALITY_BAR) {
      expect(msg).toContain(c.id + ': 3/5 (NOT met)');
    }
    expect(msg).toContain('be more concrete');
    expect(msg).toContain(previousCode);
    expect(msg).toContain('YOUR PREVIOUS OUTPUT');
  });
});

// ===========================================================================
// HERMETICITY
// ===========================================================================
describe('codegen-critique hermeticity', () => {
  it('no real fetch was issued', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
