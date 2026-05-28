// Hermetic unit test — MODEL-TIER ROUTING POLICY.
//
// Proves the central policy is correct and quality-safe WITHOUT any real
// LLM call:
//
//   1. Exhaustive: every ModelTask has a documented MODEL_POLICY entry.
//      (Adding a task without an entry / switch case fails the TYPECHECK —
//      a runtime mirror of that guarantee is asserted here.)
//   2. Conservative defaults preserved (no env): classify+critique=Haiku,
//      extract+plan+codegen+repair+refine=Sonnet. Backward compatible.
//   3. QUALITY GUARDRAIL: the codegen family (codegen/repair/refine) is
//      pinned to Sonnet and can NEVER route below it — a careless future
//      retune to a cheaper tier fails this test.
//   4. STRUCTURAL: every LLM call-site routes through modelForTask — no
//      stray quoted model-string literals remain at call-sites.
//   5. Env overrides preserved (the historical cascade) — backward compat.
//
// Stubbed: nothing. Pure functions + source-file reads. No network/LLM/DB.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MODEL_POLICY,
  MODEL_TASKS,
  modelForTask,
  tierModel,
  type ModelTask,
} from '@/lib/engine/model-policy';
import {
  CHEAP_LLM_MODEL,
  DEFAULT_LLM_MODEL,
  HEAVY_LLM_MODEL,
} from '@/lib/engine/governance/pricing';

// The env vars the policy honours — saved + cleared so the "default"
// assertions are deterministic regardless of the runner's environment.
const ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_PLANNER_MODEL',
  'ANTHROPIC_CODEGEN_MODEL',
  'CRITIQUE_GATE_MODEL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ===========================================================================
// 1. Exhaustiveness
// ===========================================================================
describe('policy is exhaustive + documented', () => {
  it('every ModelTask has a MODEL_POLICY entry with a non-empty rationale', () => {
    for (const task of MODEL_TASKS) {
      const entry = MODEL_POLICY[task];
      expect(entry, `missing policy entry for '${task}'`).toBeDefined();
      expect(entry.rationale.trim().length).toBeGreaterThan(0);
      expect(['cheap', 'default', 'heavy']).toContain(entry.tier);
    }
  });

  it('MODEL_TASKS is the complete closed set (the 7 documented tasks)', () => {
    expect([...MODEL_TASKS].sort()).toEqual(
      ['classify', 'codegen', 'critique', 'extract', 'plan', 'refine', 'repair'].sort(),
    );
    // The Record<ModelTask, …> type makes a missing entry a typecheck
    // error; the switch in modelForTask makes a missing case a typecheck
    // error too. This runtime check mirrors that for documentation.
    expect(Object.keys(MODEL_POLICY).sort()).toEqual([...MODEL_TASKS].sort());
  });
});

// ===========================================================================
// 2. Conservative defaults (no env) — backward compatible
// ===========================================================================
describe('conservative defaults preserved (no env overrides)', () => {
  it('classify + critique route to the cheap (Haiku) tier', () => {
    expect(modelForTask('classify')).toBe(CHEAP_LLM_MODEL);
    expect(modelForTask('critique')).toBe(CHEAP_LLM_MODEL);
  });

  it('extract + plan route to the default (Sonnet) tier', () => {
    expect(modelForTask('extract')).toBe(DEFAULT_LLM_MODEL);
    expect(modelForTask('plan')).toBe(DEFAULT_LLM_MODEL);
  });

  it('codegen + repair + refine route to the default (Sonnet) tier', () => {
    expect(modelForTask('codegen')).toBe(DEFAULT_LLM_MODEL);
    expect(modelForTask('repair')).toBe(DEFAULT_LLM_MODEL);
    expect(modelForTask('refine')).toBe(DEFAULT_LLM_MODEL);
  });

  it('tierModel maps tiers to the pricing constants', () => {
    expect(tierModel('cheap')).toBe(CHEAP_LLM_MODEL);
    expect(tierModel('default')).toBe(DEFAULT_LLM_MODEL);
    expect(tierModel('heavy')).toBe(HEAVY_LLM_MODEL);
  });
});

// ===========================================================================
// 3. QUALITY GUARDRAIL — codegen family never below Sonnet
// ===========================================================================
describe('codegen quality guardrail (structural)', () => {
  const CODEGEN_FAMILY: ModelTask[] = ['codegen', 'repair', 'refine'];

  it('the codegen family is flagged codegenCritical in the policy data', () => {
    for (const task of CODEGEN_FAMILY) {
      expect(MODEL_POLICY[task].codegenCritical, task).toBe(true);
    }
  });

  it('every codegenCritical task sits at default or heavy — NEVER cheap', () => {
    // This is the careless-retune tripwire: flipping any codegen-family
    // entry to tier:'cheap' fails right here.
    for (const task of MODEL_TASKS) {
      if (MODEL_POLICY[task].codegenCritical) {
        expect(MODEL_POLICY[task].tier, task).not.toBe('cheap');
        expect(['default', 'heavy']).toContain(MODEL_POLICY[task].tier);
      }
    }
  });

  it('codegen family resolves to Sonnet and never to the cheap (Haiku) model', () => {
    for (const task of CODEGEN_FAMILY) {
      expect(modelForTask(task), task).toBe(DEFAULT_LLM_MODEL);
      expect(modelForTask(task), task).not.toBe(CHEAP_LLM_MODEL);
    }
  });

  it('codegen is pinned: it is NOT the same tier as classify/critique', () => {
    expect(modelForTask('codegen')).not.toBe(modelForTask('classify'));
  });
});

// ===========================================================================
// 4. STRUCTURAL — every call-site routes through the policy
// ===========================================================================
describe('no stray model-string literals at call-sites', () => {
  // The 12 forge LLM call-sites (complete() callers). Each must route its
  // model through the policy and contain no hardcoded model id.
  const CALL_SITES = [
    'lib/engine/classify/classify.ts',
    'lib/engine/spec/extract.ts',
    'lib/engine/system/extract.ts',
    'lib/engine/software/extract.ts',
    'lib/engine/infra/extract.ts',
    'lib/engine/planner/plan.ts',
    'lib/engine/system/planner/plan.ts',
    'lib/engine/software/planner/plan.ts',
    'lib/engine/infra/planner/plan.ts',
    'lib/engine/codegen/generate.ts',
    'lib/engine/software/codegen/slots.ts',
    'lib/engine/codegen/critique.ts',
  ];

  // A quoted/backticked model id used as a value. Comments mentioning a
  // model in prose are not quoted, so they don't trip this.
  const QUOTED_MODEL_LITERAL = /['"`]claude-(?:sonnet|haiku|opus)/;

  for (const path of CALL_SITES) {
    it(`${path}: no quoted model literal + routes via modelForTask`, () => {
      const src = readFileSync(path, 'utf8');
      expect(src, path).not.toMatch(QUOTED_MODEL_LITERAL);
      expect(src, path).toMatch(/modelForTask/);
    });
  }
});

// ===========================================================================
// 5. Env overrides preserved (the historical cascade) — backward compat
// ===========================================================================
describe('env overrides preserve the historical cascade', () => {
  it('ANTHROPIC_MODEL cascades to extract + plan + codegen', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    expect(modelForTask('extract')).toBe('claude-opus-4-7');
    expect(modelForTask('plan')).toBe('claude-opus-4-7');
    expect(modelForTask('codegen')).toBe('claude-opus-4-7');
    // classify + critique are NOT affected by ANTHROPIC_MODEL.
    expect(modelForTask('classify')).toBe(CHEAP_LLM_MODEL);
    expect(modelForTask('critique')).toBe(CHEAP_LLM_MODEL);
  });

  it('ANTHROPIC_PLANNER_MODEL overrides plan + codegen, not extract', () => {
    process.env.ANTHROPIC_PLANNER_MODEL = 'planner-x';
    expect(modelForTask('extract')).toBe(DEFAULT_LLM_MODEL);
    expect(modelForTask('plan')).toBe('planner-x');
    expect(modelForTask('codegen')).toBe('planner-x');
  });

  it('ANTHROPIC_CODEGEN_MODEL overrides only the codegen family', () => {
    process.env.ANTHROPIC_CODEGEN_MODEL = 'codegen-x';
    expect(modelForTask('extract')).toBe(DEFAULT_LLM_MODEL);
    expect(modelForTask('plan')).toBe(DEFAULT_LLM_MODEL);
    expect(modelForTask('codegen')).toBe('codegen-x');
    expect(modelForTask('repair')).toBe('codegen-x');
    expect(modelForTask('refine')).toBe('codegen-x');
  });

  it('CRITIQUE_GATE_MODEL overrides only critique', () => {
    process.env.CRITIQUE_GATE_MODEL = 'critique-x';
    expect(modelForTask('critique')).toBe('critique-x');
    expect(modelForTask('classify')).toBe(CHEAP_LLM_MODEL);
  });
});
