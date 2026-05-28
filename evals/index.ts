// CLI entry — `npm run evals`.
//
// Drives `runEvals` with command-line options, prints a human-readable
// summary, and writes a timestamped JSON report to evals/reports/.
// Exit code is 0 unconditionally — this is a MEASUREMENT instrument,
// not a CI gate. (A future regression-guard wrapper can read the
// report and fail-on-drop, but that's a separate decision.)
//
// FLAGS
//   --judge           Enable the judged tier. Self-skips if no key.
//   --only <id>       Comma-separated case ids to run (e.g.
//                     "agent.daily_website_watch,system.weekly_news_brief").
//   --stub            Run with stub generators (for smoke testing the
//                     harness itself). Generation mode is recorded as
//                     'stubbed' in the report.
//   --out <dir>       Override reports directory (default evals/reports).
//   --help            Print usage and exit.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GOLDEN_CASES } from './golden';
import { JUDGED_CRITERIA, STRUCTURAL_CRITERIA } from './rubric';
import {
  runEvals,
  type Extractors,
  type Generators,
  type RunReport,
} from './runner';

interface CliArgs {
  judge: boolean;
  only: string[] | null;
  stub: boolean;
  outDir: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    judge: false,
    only: null,
    stub: false,
    outDir: 'evals/reports',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--judge') args.judge = true;
    else if (a === '--stub') args.stub = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--only') {
      const v = argv[++i];
      if (!v) throw new Error('--only requires a value');
      args.only = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('--out requires a value');
      args.outDir = v;
    }
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Aurexis Forge eval harness — measures the quality of generated output.',
      '',
      'Usage: npm run evals -- [flags]',
      '',
      'Flags:',
      '  --judge             Enable LLM-as-judge tier (costs $; self-skips with no key).',
      '  --only <id1,id2>    Run only the listed case ids.',
      '  --stub              Use stub generators (smoke-test the harness).',
      '  --out <dir>         Output directory (default evals/reports/).',
      '  --help              Print this help.',
      '',
      'Without --judge: structural tier only. Free + key-free.',
      'With --judge: structural + judged. Real LLM calls; budget+ledger applies.',
      '',
    ].join('\n'),
  );
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '   - ';
  return (n * 100).toFixed(0).padStart(3, ' ') + '%';
}

function fmtScore(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return ' -.- ';
  return n.toFixed(2);
}

function printReport(report: RunReport): void {
  const lines: string[] = [];
  lines.push('');
  lines.push('=== AUREXIS FORGE — EVAL REPORT ===');
  lines.push('run id          : ' + report.runId);
  lines.push('rubric version  : ' + report.rubricVersion);
  lines.push('generation mode : ' + report.meta.generationMode);
  lines.push(
    'judge           : ' +
      (report.meta.judgeEnabled
        ? 'enabled (model=' + (report.meta.judgeModel ?? '?') + ')'
        : 'disabled'),
  );
  lines.push('REQUIRE_BYOK    : ' + String(report.meta.requireByok));
  lines.push('');
  for (const c of report.cases) {
    lines.push('--- ' + c.case.id + ' [' + c.case.kind + '] ---');
    lines.push('  description : ' + c.case.description);
    // Spec-fidelity tier — runs for every case (including infra).
    lines.push(
      '  extraction  : ' +
        c.specFidelity.extraction.status +
        (c.specFidelity.extraction.reason
          ? ' (' + c.specFidelity.extraction.reason + ')'
          : '') +
        ' — ' +
        c.specFidelity.extraction.durationMs +
        'ms',
    );
    if ('passedCount' in c.specFidelity.structural) {
      const s = c.specFidelity.structural;
      lines.push(
        '  spec struct : ' +
          s.passedCount +
          '/' +
          s.totalCount +
          ' criteria pass',
      );
      for (const crit of s.criteria) {
        const marker = crit.ok ? '  ✓' : '  ✗';
        const tail = crit.ok ? '' : '  — ' + crit.failures.slice(0, 2).join('; ');
        lines.push('    ' + marker + ' ' + crit.label + tail);
      }
    } else {
      lines.push('  spec struct : skipped (' + c.specFidelity.structural.reason + ')');
    }
    if (c.specFidelity.judged.status === 'completed') {
      lines.push('  spec judged : completed (' + c.specFidelity.judged.modelUsed + ')');
    } else if (c.specFidelity.judged.status === 'failed') {
      lines.push('  spec judged : FAILED — ' + c.specFidelity.judged.error);
    } else {
      lines.push('  spec judged : skipped (' + c.specFidelity.judged.reason + ')');
    }
    lines.push(
      '  generation  : ' +
        c.generation.status +
        (c.generation.reason ? ' (' + c.generation.reason + ')' : '') +
        ' — ' +
        c.generation.fileCount +
        ' files, ' +
        c.generation.durationMs +
        'ms',
    );
    if ('passedCount' in c.structural) {
      const s = c.structural;
      lines.push(
        '  structural  : ' +
          s.passedCount +
          '/' +
          s.totalCount +
          ' criteria pass',
      );
      for (const crit of s.criteria) {
        const marker = crit.ok ? '  ✓' : '  ✗';
        const tail = crit.ok
          ? ''
          : '  — ' + crit.failures.slice(0, 2).join('; ');
        lines.push('    ' + marker + ' ' + crit.label + tail);
      }
    } else {
      lines.push('  structural  : skipped (' + c.structural.reason + ')');
    }
    if (c.judged.status === 'completed') {
      lines.push('  judged      : completed (' + c.judged.modelUsed + ')');
      for (const crit of JUDGED_CRITERIA) {
        const mean = c.judged.criterionAverages[crit.id];
        lines.push('    • ' + crit.label.padEnd(22) + '  ' + fmtScore(mean) + ' / 5');
      }
    } else if (c.judged.status === 'failed') {
      lines.push('  judged      : FAILED — ' + c.judged.error);
    } else {
      lines.push('  judged      : skipped (' + c.judged.reason + ')');
    }
    lines.push('');
  }
  lines.push('=== aggregate ===');
  lines.push(
    'spec structural pass rate : ' +
      fmtPct(report.aggregate.specStructuralPassRate),
  );
  lines.push(
    'spec judged cases scored  : ' +
      String(report.aggregate.specJudgedCasesScored),
  );
  lines.push(
    'gen structural pass rate  : ' + fmtPct(report.aggregate.structuralPassRate),
  );
  lines.push(
    'gen judged cases scored   : ' +
      String(report.aggregate.judgedCasesScored),
  );
  if (report.aggregate.judgedCasesScored > 0) {
    for (const crit of JUDGED_CRITERIA) {
      const m = report.aggregate.judgedCriterionAverages[crit.id];
      lines.push(
        '  ' + crit.label.padEnd(22) + '  ' + fmtScore(m) + ' / 5',
      );
    }
  }
  lines.push('');
  // Sanity reference to the rubric in case the reader pulls this out
  // of a CI log without the JSON.
  lines.push('rubric (structural):');
  for (const c of STRUCTURAL_CRITERIA) {
    lines.push('  - ' + c.id + ' :: ' + c.label);
  }
  lines.push('rubric (judged):');
  for (const c of JUDGED_CRITERIA) {
    lines.push('  - ' + c.id + ' :: ' + c.label);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function writeReport(outDir: string, report: RunReport): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'evals-' + report.runId + '.json');
  // The JSON.stringify replacer turns NaN -> null so the file is
  // valid JSON (NaN is not a JSON value). Downstream comparators
  // should treat null as "no score".
  const json = JSON.stringify(
    report,
    (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v),
    2,
  );
  await fs.writeFile(file, json + '\n', 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// Stub generators — used when --stub is set. Mirror the real summary
// shapes so the rest of the harness behaves identically. The content
// is intentionally NOT-LLM-quality so the structural tier exercises
// its placeholder + import scanners on something real.
// ---------------------------------------------------------------------------
const STUB_GENERATORS: Generators = {
  agent: async () => ({
    files: [
      {
        path: 'src/index.ts',
        content:
          "// stub entrypoint\nimport { run } from './core';\nexport const handler = async (input: { watch_url: string }) => {\n  return run(input.watch_url);\n};\n",
        source: 'generated' as const,
        bytes: 0,
        staticCheck: { ok: true } as const,
      },
      {
        path: 'src/diff.ts',
        content: "export const sha256 = (s: string): string => s;\n",
        source: 'generated' as const,
        bytes: 0,
        staticCheck: { ok: true } as const,
      },
      {
        path: 'src/storage.ts',
        content: "export const load = async (): Promise<string> => '';\n",
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
    models: ['stub'],
    scaffoldId: 'agent-node-tool-using',
    requestedScaffoldId: 'agent-node-tool-using',
  }),
  system: async () => ({
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
          "// gatherer module — calls http_request\nexport const run = async () => ({ items: [] });\n",
        source: 'generated' as const,
        bytes: 0,
        staticCheck: { ok: true } as const,
      },
      {
        path: 'src/modules/summariser/index.ts',
        content:
          "// summariser module — calls llm_completion\nexport const run = async () => ({ summaries: [] });\n",
        source: 'generated' as const,
        bytes: 0,
        staticCheck: { ok: true } as const,
      },
      {
        path: 'src/modules/brief_writer/index.ts',
        content: "export const run = async () => 'brief';\n",
        source: 'generated' as const,
        bytes: 0,
        staticCheck: { ok: true } as const,
      },
    ],
    warnings: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    attempts: 0,
    modulesGenerated: 0,
    modulesFailed: 0,
    orchestratorPath: 'src/orchestrator.ts',
    entrypointPath: 'src/system.ts',
    modelsUsed: ['stub'],
    perModule: [],
    scaffoldId: 'agent-node-tool-using',
  }),
  software: async () => ({
    files: [
      {
        path: 'middleware.ts',
        content: "export { default } from './lib/auth/session';\n",
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
        content: "export const rls = true;\n",
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
          "-- generated migration\ncreate table expense ( id uuid );\nalter table expense enable row level security;\n",
        source: 'generated' as const,
        bytes: 0,
        staticCheck: { ok: true } as const,
      },
      {
        path: 'app/api/expense/_list.ts',
        content:
          "import { getServerSupabase } from '@/lib/supabase/server';\nexport async function listExpenses() {\n  const sb = getServerSupabase();\n  return sb.from('expense').select('*');\n}\n",
        source: 'generated' as const,
        bytes: 0,
        staticCheck: { ok: true } as const,
      },
      {
        path: 'app/api/expense/_create.ts',
        content:
          "// create expense row for the signed-in user\nexport async function createExpense() { return { id: 'x' }; }\n",
        source: 'generated' as const,
        bytes: 0,
        staticCheck: { ok: true } as const,
      },
      {
        path: 'app/api/expense/[id]/_update.ts',
        content:
          "// update expense row\nexport async function updateExpense() { return { ok: true }; }\n",
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
    modelsUsed: ['stub'],
    slotCounts: { deterministic: 0, llm: 0 },
    perSlot: [],
    llmFilesFailed: 0,
    scaffoldId: 'nextjs-supabase-app',
  }),
};

// Stub extractors — used with --stub so the CLI does not hit the
// real LLM for the spec-fidelity tier either. Each returns the case's
// pinned spec verbatim (the runner reads `result.spec`), so the
// scorer exercises the structural checks on a known-good shape.
const STUB_EXTRACTORS: Extractors = (() => {
  // Returns a function that satisfies the extractor signature but
  // produces a canned ExtractionResult from the case spec.
  const make = <S>(spec: S) =>
    async () => ({
      result: { spec, open_questions: [] as string[] },
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'stub-extractor',
      attempts: 1,
    });
  // GOLDEN_CASES is imported at module top — safe by the time this
  // IIFE evaluates because TS hoists imports.
  const get = (k: 'agent' | 'system' | 'software' | 'infrastructure') =>
    GOLDEN_CASES.find((c) => c.kind === k);
  return {
    agent: make(get('agent')?.spec) as Extractors['agent'],
    system: make(get('system')?.spec) as Extractors['system'],
    software: make(get('software')?.spec) as Extractors['software'],
    infrastructure: make(get('infrastructure')?.spec) as Extractors['infrastructure'],
  };
})();

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }
  const report = await runEvals({
    judge: args.judge,
    specJudge: args.judge, // honour --judge for both tiers
    onlyCaseIds: args.only ?? undefined,
    generators: args.stub ? STUB_GENERATORS : undefined,
    extractors: args.stub ? STUB_EXTRACTORS : undefined,
    generationMode: args.stub ? 'stubbed' : 'real',
    extractionMode: args.stub ? 'stubbed' : 'real',
  });
  printReport(report);
  const file = await writeReport(args.outDir, report);
  process.stdout.write('\nwrote report → ' + file + '\n');
}

// Run unconditionally when this module is imported as the entry —
// vite-node + `npm run evals` always come in through this file, and
// the hermetic test never imports it (it pulls `runEvals` from
// evals/runner directly). Keeping this top-level avoids fragile
// argv-string sniffing across runtimes.
main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(
    '[evals] runner failed: ' +
      (err instanceof Error ? err.stack ?? err.message : String(err)) +
      '\n',
  );
  process.exit(1);
});
