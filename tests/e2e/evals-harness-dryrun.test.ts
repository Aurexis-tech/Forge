// Hermetic test for the EVAL HARNESS itself.
//
// Distinct from every other test in this suite — the others prove
// correctness of the engine. THIS one proves the eval instrument
// works: it can drive a generator (stubbed), score the output
// structurally, key-gate the judged tier, and produce a report.
//
// What runs for real:
//   - The full evals/runner + evals/structural + evals/judge code.
//   - The rubric.
//   - The golden case registry.
//
// What is STUBBED:
//   - The three codegen generators (`generateCode`,
//     `generateSystemCode`, `generateSoftwareCode`) — replaced via
//     the runner's `generators` seam with canned summaries.
//   - The model-key probe (`peekKeySource` / `resolveKey`) — by
//     leaving REQUIRE_BYOK=true (the test default) and user_id=null,
//     the judge self-skips with reason='no_anthropic_key'.
//
// NO real fetch. NO real LLM call. NO real DB write.

import { describe, expect, it, vi } from 'vitest';
import {
  runEvals,
  type Extractors,
  type Generators,
  type RunReport,
} from '@/evals/runner';
import { GOLDEN_CASES } from '@/evals/golden';
import { JUDGED_CRITERIA, STRUCTURAL_CRITERIA } from '@/evals/rubric';
import { scoreStructural } from '@/evals/structural';

// Mock the key probe: pretend no anthropic key is configured. The
// judged tier must then self-skip with reason='no_anthropic_key'.
// `tests/setup.ts` would otherwise leave a fake platform key in env,
// making peekKeySource report a (broken) platform key.
vi.mock('@/lib/engine/keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/engine/keys')>(
    '@/lib/engine/keys',
  );
  return {
    ...actual,
    peekKeySource: vi.fn(async () => ({ source: 'missing', key_last4: null })),
  };
});

// ===========================================================================
// Test fixtures — minimal valid generator stubs.
// Each returns a summary whose `files` array contains exactly the
// paths the golden case contract demands, with non-placeholder
// content. The structural tier should report all-pass on this input.
// ===========================================================================

const cleanAgent = {
  files: [
    {
      path: 'src/index.ts',
      content:
        "import { run } from './core';\nexport const handler = async (input: { watch_url: string }) => {\n  return run(input.watch_url);\n};\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'src/diff.ts',
      content:
        "import { createHash } from 'node:crypto';\nexport const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'src/storage.ts',
      content:
        "export const load = async (key: string): Promise<string> => {\n  const raw = await readFile(key);\n  return raw;\n};\nasync function readFile(_k: string): Promise<string> { return ''; }\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
  ],
  warnings: [],
  usage: { input_tokens: 0, output_tokens: 0 },
  attempts: 0,
  llmFilesGenerated: 0,
  llmFilesFailed: 0,
  models: ['stub-model'],
  scaffoldId: 'agent-node-tool-using',
  requestedScaffoldId: 'agent-node-tool-using',
};

const cleanSystem = {
  files: [
    {
      path: 'src/system.ts',
      content: "export const main = async () => undefined;\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'src/orchestrator.ts',
      content: "export const orchestrate = async () => undefined;\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'src/modules/gatherer/index.ts',
      content:
        "// gatherer — calls http_request to fetch sources\nimport { http_request } from '../../tools';\nexport const run = async () => http_request({ url: 'x' });\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'src/modules/summariser/index.ts',
      content:
        "// summariser — uses llm_completion\nimport { llm_completion } from '../../tools';\nexport const run = async (items: string[]) => llm_completion({ items });\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'src/modules/brief_writer/index.ts',
      content:
        "// brief writer\nexport const run = async (summaries: string[]) => summaries.join('\\n');\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
  ],
  warnings: [],
  usage: { input_tokens: 0, output_tokens: 0 },
  attempts: 0,
  modulesGenerated: 3,
  modulesFailed: 0,
  orchestratorPath: 'src/orchestrator.ts',
  entrypointPath: 'src/system.ts',
  modelsUsed: ['stub-model'],
  perModule: [],
  scaffoldId: 'agent-node-tool-using',
};

const cleanSoftware = {
  files: [
    {
      path: 'middleware.ts',
      content: "export { default } from '@/lib/auth/middleware';\n",
      source: 'scaffold' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'lib/auth/roles.ts',
      content: "export const ROLES = ['user'] as const;\n",
      source: 'scaffold' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'lib/auth/rls.ts',
      content: "export const rlsCheck = true;\n",
      source: 'scaffold' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'app/sign-in/page.tsx',
      content: "export default function SignInPage() { return null; }\n",
      source: 'scaffold' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'supabase/migrations/0001_init.sql',
      content:
        "create table expense ( id uuid );\nalter table expense enable row level security;\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'app/api/expense/_list.ts',
      content:
        "import { getServerSupabase } from '@/lib/supabase/server';\nexport async function listExpense(userId: string) {\n  const sb = getServerSupabase();\n  return sb.from('expense').select('*').eq('user_id', userId);\n}\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'app/api/expense/_create.ts',
      content:
        "import { getServerSupabase } from '@/lib/supabase/server';\nexport async function createExpense(input: { amount: number }, userId: string) {\n  const sb = getServerSupabase();\n  return sb.from('expense').insert({ amount: input.amount, user_id: userId });\n}\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'app/api/expense/[id]/_update.ts',
      content:
        "import { getServerSupabase } from '@/lib/supabase/server';\nexport async function updateExpense(id: string, approved: boolean) {\n  const sb = getServerSupabase();\n  return sb.from('expense').update({ approved }).eq('id', id);\n}\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'app/(app)/list-expenses/page.tsx',
      content: "export default function ListExpensesPage() { return null; }\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'app/(app)/new-expense/page.tsx',
      content: "export default function NewExpensePage() { return null; }\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
    {
      path: 'app/(app)/expense-detail/page.tsx',
      content: "export default function ExpenseDetailPage() { return null; }\n",
      source: 'generated' as const,
      bytes: 0,
      staticCheck: { ok: true } as const,
    },
  ],
  warnings: [],
  usage: { input_tokens: 0, output_tokens: 0 },
  attempts: 0,
  modelsUsed: ['stub-model'],
  slotCounts: { deterministic: 5, llm: 6 },
  perSlot: [],
  llmFilesFailed: 0,
  scaffoldId: 'nextjs-supabase-app',
};

const STUB_GENERATORS: Generators = {
  agent: vi.fn(async () => cleanAgent),
  system: vi.fn(async () => cleanSystem),
  software: vi.fn(async () => cleanSoftware),
} as unknown as Generators;

// Stub extractors — each returns the matching golden case's own
// pinned spec so the spec-fidelity structural tier scores all-pass
// on the canned output. No real LLM call.
const stubExtraction = <S>(spec: S) =>
  vi.fn(async () => ({
    result: { spec, open_questions: [] as string[] },
    usage: { input_tokens: 0, output_tokens: 0 },
    model: 'stub-extractor',
    attempts: 1,
  }));

function makeStubExtractors(): Extractors {
  const get = (k: 'agent' | 'system' | 'software' | 'infrastructure') =>
    GOLDEN_CASES.find((c) => c.kind === k);
  return {
    agent: stubExtraction(get('agent')?.spec) as Extractors['agent'],
    system: stubExtraction(get('system')?.spec) as Extractors['system'],
    software: stubExtraction(get('software')?.spec) as Extractors['software'],
    infrastructure: stubExtraction(get('infrastructure')?.spec) as Extractors['infrastructure'],
  };
}

// ===========================================================================
// HARNESS END-TO-END
// ===========================================================================
describe('Eval harness machinery — runner drives the rubric over stubbed generators', () => {
  it('runs end-to-end: loads cases, drives BOTH tiers, key-gates judged', async () => {
    // peekKeySource is mocked above to return 'missing' regardless of
    // env — so BOTH judged tiers (generation + spec) self-skip with
    // reason 'no_anthropic_key'. This proves both key gates work.

    const stubExtractors = makeStubExtractors();
    const report: RunReport = await runEvals({
      judge: true,      // generation judged: user opted in, should still skip
      specJudge: true,  // spec judged: user opted in, should still skip
      generators: STUB_GENERATORS,
      extractors: stubExtractors,
      generationMode: 'stubbed',
      extractionMode: 'stubbed',
    });

    // 1. Walks every case in the registry (including infra).
    expect(report.cases.length).toBe(GOLDEN_CASES.length);
    expect(report.cases.map((c) => c.case.id).sort()).toEqual(
      GOLDEN_CASES.map((c) => c.id).slice().sort(),
    );

    // 2. Generation: COMPLETED for cases with a plan, SKIPPED for infra.
    for (const c of report.cases) {
      if (c.case.kind === 'infrastructure') {
        expect(c.generation.status).toBe('skipped');
        expect(c.generation.reason).toBe('no_llm_generation_for_this_mold');
      } else {
        expect(c.generation.status).toBe('completed');
        expect(c.generation.fileCount).toBeGreaterThan(0);
      }
    }

    // 3. Each stub generator was called exactly once (no infra
    //    generator).
    expect((STUB_GENERATORS.agent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((STUB_GENERATORS.system as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((STUB_GENERATORS.software as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // 4. Each stub EXTRACTOR was called exactly once — including infra.
    expect((stubExtractors.agent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((stubExtractors.system as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((stubExtractors.software as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((stubExtractors.infrastructure as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // 5. Generation structural ran for cases with a plan, skipped for infra.
    for (const c of report.cases) {
      if (c.case.kind === 'infrastructure') {
        expect('passedCount' in c.structural).toBe(false);
      } else {
        expect('passedCount' in c.structural).toBe(true);
        if ('passedCount' in c.structural) {
          expect(c.structural.criteria.length).toBe(STRUCTURAL_CRITERIA.length);
        }
      }
    }

    // 6. SPEC structural ran for EVERY case (including infra). Each
    //    case's structural report has 5 criteria.
    for (const c of report.cases) {
      expect('passedCount' in c.specFidelity.structural).toBe(true);
      if ('passedCount' in c.specFidelity.structural) {
        expect(c.specFidelity.structural.criteria.length).toBe(5);
        // The stub extractor returned the case's pinned spec, so
        // every structural criterion should pass.
        expect(c.specFidelity.structural.allOk).toBe(true);
      }
    }

    // 7. Spec extraction completed for every case (stubs).
    for (const c of report.cases) {
      expect(c.specFidelity.extraction.status).toBe('completed');
      expect(c.specFidelity.extraction.model).toBe('stub-extractor');
    }

    // 8. Both judged tiers SKIPPED everywhere (no key).
    for (const c of report.cases) {
      expect(c.judged.status).toBe('skipped');
      expect(c.specFidelity.judged.status).toBe('skipped');
      if (c.specFidelity.judged.status === 'skipped') {
        expect(c.specFidelity.judged.reason).toBe('no_anthropic_key');
      }
    }

    // 9. Run header reflects both modes + spec-bar version.
    expect(report.meta.generationMode).toBe('stubbed');
    expect(report.meta.extractionMode).toBe('stubbed');
    expect(report.meta.judgeEnabled).toBe(true);
    expect(report.meta.specJudgeEnabled).toBe(true);
    expect(report.rubricVersion).toBeDefined();
    expect(report.specBarVersion).toBeDefined();

    // 10. Aggregate carries both tiers.
    expect(report.aggregate.cases).toBe(GOLDEN_CASES.length);
    expect(Number.isFinite(report.aggregate.specStructuralPassRate)).toBe(true);
    expect(report.aggregate.specJudgedCasesScored).toBe(0);
    expect(report.aggregate.judgedCasesScored).toBe(0);
  });

  it('--only filter restricts the run to a subset', async () => {
    const fresh: Generators = {
      agent: vi.fn(async () => cleanAgent),
      system: vi.fn(async () => cleanSystem),
      software: vi.fn(async () => cleanSoftware),
    } as unknown as Generators;
    const freshExtractors = makeStubExtractors();
    const report = await runEvals({
      judge: false,
      generators: fresh,
      extractors: freshExtractors,
      generationMode: 'stubbed',
      extractionMode: 'stubbed',
      onlyCaseIds: ['agent.daily_website_watch'],
    });
    expect(report.cases.length).toBe(1);
    const first = report.cases[0];
    expect(first).toBeDefined();
    expect(first!.case.id).toBe('agent.daily_website_watch');
    expect((fresh.agent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // The system + software stubs were NOT called.
    expect((fresh.system as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((fresh.software as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

// ===========================================================================
// STRUCTURAL SCORER — direct unit-style tests against the placeholder
// + import + missing-file detectors. Locks the meaning of "good" in
// place so a future refactor can't quietly weaken a criterion.
// ===========================================================================
describe('Structural scorer — placeholder + import + file-coverage detection', () => {
  const agentCase = GOLDEN_CASES.find((c) => c.kind === 'agent')!;

  it('passes on a clean stub generator output', () => {
    const r = scoreStructural({
      caseDef: agentCase,
      files: cleanAgent.files,
      rubricVersion: '1.0.0',
    });
    expect(r.allOk).toBe(true);
    expect(r.passedCount).toBe(r.totalCount);
  });

  it('FAILS no_placeholders when a file contains TODO / FIXME / empty body', () => {
    const dirty = [
      ...cleanAgent.files.slice(0, 2),
      {
        path: 'src/storage.ts',
        content:
          "export const load = async (): Promise<string> => {\n  // TODO: implement\n  return '';\n};\n",
        source: 'generated' as const,
        staticCheck: { ok: true } as const,
      },
    ];
    const r = scoreStructural({
      caseDef: agentCase,
      files: dirty,
      rubricVersion: '1.0.0',
    });
    const ph = r.criteria.find((c) => c.id === 'no_placeholders')!;
    expect(ph.ok).toBe(false);
    expect(ph.failures.join(' | ')).toMatch(/storage\.ts/);
    expect(ph.failures.join(' | ')).toMatch(/TODO/i);
  });

  it('FAILS plan_files_materialised when an expected path is missing', () => {
    const missing = cleanAgent.files.filter((f) => f.path !== 'src/diff.ts');
    const r = scoreStructural({
      caseDef: agentCase,
      files: missing,
      rubricVersion: '1.0.0',
    });
    const pf = r.criteria.find((c) => c.id === 'plan_files_materialised')!;
    expect(pf.ok).toBe(false);
    expect(pf.failures.join(' | ')).toMatch(/src\/diff\.ts/);
  });

  it('FAILS no_forbidden_imports when a forbidden import is present', () => {
    // Agent forbids react / next / @/lib/supabase imports. Force one.
    const tainted = [
      {
        path: 'src/index.ts',
        content:
          "import { createClient } from '@/lib/supabase/server';\nexport const handler = async (input: { watch_url: string }) => createClient();\n",
        source: 'generated' as const,
        staticCheck: { ok: true } as const,
      },
      ...cleanAgent.files.slice(1),
    ];
    const r = scoreStructural({
      caseDef: agentCase,
      files: tainted,
      rubricVersion: '1.0.0',
    });
    const fi = r.criteria.find((c) => c.id === 'no_forbidden_imports')!;
    expect(fi.ok).toBe(false);
    expect(fi.failures.join(' | ')).toMatch(/@\/lib\/supabase/);
  });

  it('FAILS required_content_present when a path lacks the required match', () => {
    const stub = [
      {
        path: 'src/index.ts',
        content: "export const handler = async () => null;\n", // no 'watch_url'
        source: 'generated' as const,
        staticCheck: { ok: true } as const,
      },
      ...cleanAgent.files.slice(1),
    ];
    const r = scoreStructural({
      caseDef: agentCase,
      files: stub,
      rubricVersion: '1.0.0',
    });
    const rc = r.criteria.find((c) => c.id === 'required_content_present')!;
    expect(rc.ok).toBe(false);
    expect(rc.failures.join(' | ')).toMatch(/src\/index\.ts/);
  });

  it('FAILS static_check_passes when a file carries an esbuild error', () => {
    const broken = [
      {
        path: 'src/index.ts',
        content: 'export const handler = async (',
        source: 'generated' as const,
        staticCheck: { ok: false as const, error: 'unexpected end of input' },
      },
      ...cleanAgent.files.slice(1),
    ];
    const r = scoreStructural({
      caseDef: agentCase,
      files: broken,
      rubricVersion: '1.0.0',
    });
    const sc = r.criteria.find((c) => c.id === 'static_check_passes')!;
    expect(sc.ok).toBe(false);
    expect(sc.failures.join(' | ')).toMatch(/unexpected/i);
  });
});

// ===========================================================================
// HERMETICITY GUARD — proves no real fetch happened during the run.
// ===========================================================================
describe('Eval harness hermeticity', () => {
  it('no real fetch was issued — tests/setup throwing-fetch is still in place', async () => {
    const f = globalThis.fetch as unknown as (
      ...a: unknown[]
    ) => Promise<unknown>;
    await expect(f('http://will-throw.invalid')).rejects.toThrow(
      /real fetch\(\) blocked/,
    );
  });
});
