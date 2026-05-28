// Structural scoring tier — DETERMINISTIC, no LLM.
//
// Walks a generated build and checks the rubric's structural
// criteria against the case contract. Pure pass/fail per criterion.
// This tier ALWAYS runs (no model key required) and is the
// regression guard once a quality bar is set.
//
// Reuses the codegen pipeline's per-file staticCheck — does NOT
// re-run esbuild here. Each generated file already carries its
// staticCheck result.

import type { StaticCheckResult } from '@/lib/engine/codegen/staticcheck';
import type { GoldenCase } from './golden';
import { STRUCTURAL_CRITERIA } from './rubric';

// A unified file shape across all three molds. The three codegen
// summaries (CodegenSummary, SystemCodegenSummary,
// SoftwareCodegenSummary) all emit objects with at least these
// fields — the runner normalises into this shape before scoring.
export interface UnifiedGenFile {
  path: string;
  content: string;
  source: 'scaffold' | 'generated';
  staticCheck: StaticCheckResult;
}

export interface StructuralCriterionResult {
  id: string;
  label: string;
  ok: boolean;
  // When `ok` is false, one or more short detail strings explaining
  // the failure. Shown in the report; capped at 5 entries so a wholly
  // broken build does not blow up the JSON.
  failures: string[];
}

export interface StructuralFileFinding {
  path: string;
  staticCheckOk: boolean;
  staticCheckError: string | null;
  placeholderHits: string[];
  forbiddenImportHits: string[];
}

export interface StructuralReport {
  caseId: string;
  rubricVersion: string;
  criteria: StructuralCriterionResult[];
  fileFindings: StructuralFileFinding[];
  filesEvaluated: number;
  passedCount: number;
  totalCount: number;
  // Convenience flag — true iff every criterion passed.
  allOk: boolean;
}

// ---------------------------------------------------------------------------
// Placeholder detection.
//
// The patterns below cover the failure modes a prompt-regression
// produces in practice. Comments inside generated TS, plus the most
// common empty-body shapes. We deliberately keep this conservative
// (high precision, may miss exotic stubs) — a regression is normally
// LOUD, and the judged tier picks up subtler stubs.
// ---------------------------------------------------------------------------
const PLACEHOLDER_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'TODO comment', re: /(?:\/\/|\/\*|\*)\s*TODO\b/i },
  { label: 'FIXME comment', re: /(?:\/\/|\/\*|\*)\s*FIXME\b/i },
  { label: 'XXX comment', re: /(?:\/\/|\/\*|\*)\s*XXX\b/i },
  { label: 'not-implemented string', re: /not\s*implemented/i },
  { label: 'unimplemented string', re: /unimplemented/i },
  { label: 'placeholder marker', re: /\bplaceholder\b/i },
  // Empty function body inside a non-trivial declaration.
  // Matches `function foo(...) { }` or `foo(...) { }` with only
  // whitespace between the braces.
  {
    label: 'empty function body',
    re: /\b(?:function\s+\w+|async\s+function\s+\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{\s*\}/,
  },
  // Arrow function returning nothing meaningful inline.
  // e.g. `() => {}` or `(x) => null` are the most common stub shapes.
  // We exclude `() => ({})` which is a legitimate empty-object return.
  {
    label: 'empty arrow body',
    re: /=>\s*\{\s*\}(?!\s*\))/,
  },
  // `throw new Error('not yet')` style stub — explicit refusal.
  {
    label: 'throws-not-implemented',
    re: /throw\s+new\s+\w*Error\s*\(\s*['"`][^'"`]*(?:not\s*implemented|todo|unimplemented|stub)/i,
  },
];

function scanForPlaceholders(content: string): string[] {
  const hits: string[] = [];
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.re.test(content)) {
      hits.push(p.label);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Import scanning. We scan the actual `import ... from '...'` source
// rather than try to parse the AST — esbuild already verified the
// file parses, and a regex over the static import shape is reliable
// for this purpose. Dynamic imports (`import('...')`) are also caught.
// ---------------------------------------------------------------------------
const IMPORT_RE = /(?:^|\n)\s*import\s+[^'"`;]+\s+from\s+['"`]([^'"`]+)['"`]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
// Bare-side-effect imports: `import 'foo';`
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+['"`]([^'"`]+)['"`]/g;

function collectImports(content: string): string[] {
  const out: string[] = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const capture = m[1];
      if (typeof capture === 'string') out.push(capture);
    }
  }
  return out;
}

function scanForForbiddenImports(
  content: string,
  forbidden: readonly RegExp[],
): string[] {
  if (forbidden.length === 0) return [];
  const imports = collectImports(content);
  const hits: string[] = [];
  for (const imp of imports) {
    for (const pat of forbidden) {
      if (pat.test(imp)) {
        hits.push(imp);
        break;
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Main entry: score one case's output against the rubric.
// ---------------------------------------------------------------------------
export interface ScoreStructuralArgs {
  caseDef: GoldenCase;
  files: readonly UnifiedGenFile[];
  rubricVersion: string;
}

export function scoreStructural(args: ScoreStructuralArgs): StructuralReport {
  const { caseDef, files, rubricVersion } = args;
  const contract = caseDef.contract;
  const fileFindings: StructuralFileFinding[] = [];

  // Per-file scan — we walk every file once and record findings.
  for (const f of files) {
    const placeholderHits =
      f.source === 'generated' ? scanForPlaceholders(f.content) : [];
    const forbiddenHits = scanForForbiddenImports(
      f.content,
      contract.forbiddenImportPatterns,
    );
    fileFindings.push({
      path: f.path,
      staticCheckOk: f.staticCheck.ok,
      staticCheckError: f.staticCheck.ok ? null : f.staticCheck.error,
      placeholderHits,
      forbiddenImportHits: forbiddenHits,
    });
  }

  // -----------------------------------------------------------------
  // Criterion 1 — static_check_passes
  // -----------------------------------------------------------------
  const staticFailures: string[] = [];
  for (const finding of fileFindings) {
    if (!finding.staticCheckOk) {
      staticFailures.push(
        finding.path + ' :: ' + (finding.staticCheckError ?? 'unknown error'),
      );
    }
  }
  const staticOk = staticFailures.length === 0;

  // -----------------------------------------------------------------
  // Criterion 2 — no_placeholders (generated files only)
  // -----------------------------------------------------------------
  const placeholderFailures: string[] = [];
  for (const finding of fileFindings) {
    if (finding.placeholderHits.length > 0) {
      placeholderFailures.push(
        finding.path + ' :: ' + finding.placeholderHits.join(', '),
      );
    }
  }
  const placeholdersOk = placeholderFailures.length === 0;

  // -----------------------------------------------------------------
  // Criterion 3 — plan_files_materialised
  // -----------------------------------------------------------------
  const filePaths = new Set(files.map((f) => f.path));
  const missingFiles: string[] = [];
  for (const expected of contract.expectedFilePaths) {
    if (!filePaths.has(expected)) missingFiles.push(expected);
  }
  if (contract.entrypointPath && !filePaths.has(contract.entrypointPath)) {
    if (!missingFiles.includes(contract.entrypointPath)) {
      missingFiles.push('(entrypoint) ' + contract.entrypointPath);
    }
  }
  const planFilesOk = missingFiles.length === 0;

  // -----------------------------------------------------------------
  // Criterion 4 — no_forbidden_imports
  // -----------------------------------------------------------------
  const forbiddenFailures: string[] = [];
  for (const finding of fileFindings) {
    if (finding.forbiddenImportHits.length > 0) {
      forbiddenFailures.push(
        finding.path +
          ' imports ' +
          finding.forbiddenImportHits.join(', '),
      );
    }
  }
  const forbiddenOk = forbiddenFailures.length === 0;

  // -----------------------------------------------------------------
  // Criterion 5 — required_content_present
  // -----------------------------------------------------------------
  const contentFailures: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const req of contract.requiredFileContents) {
    const f = byPath.get(req.path);
    if (!f) {
      contentFailures.push(req.path + ' :: file missing (cannot match)');
      continue;
    }
    const ok = req.mustMatchAny.some((re) => re.test(f.content));
    if (!ok) {
      contentFailures.push(
        req.path +
          ' :: none of [' +
          req.mustMatchAny.map((re) => re.source).join(' | ') +
          '] matched',
      );
    }
  }
  const contentOk = contentFailures.length === 0;

  // -----------------------------------------------------------------
  // Assemble the criterion-aligned report.
  // -----------------------------------------------------------------
  const cap = (arr: string[]): string[] => arr.slice(0, 5);

  // The criteria id strings here MUST match STRUCTURAL_CRITERIA in
  // rubric.ts. The compiler can't catch that automatically without
  // pulling them as constants — guard with a sanity check below.
  const results: StructuralCriterionResult[] = [
    {
      id: 'static_check_passes',
      label: 'Static check passes',
      ok: staticOk,
      failures: cap(staticFailures),
    },
    {
      id: 'no_placeholders',
      label: 'No placeholder bodies',
      ok: placeholdersOk,
      failures: cap(placeholderFailures),
    },
    {
      id: 'plan_files_materialised',
      label: 'Plan files materialised',
      ok: planFilesOk,
      failures: cap(missingFiles),
    },
    {
      id: 'no_forbidden_imports',
      label: 'No forbidden imports',
      ok: forbiddenOk,
      failures: cap(forbiddenFailures),
    },
    {
      id: 'required_content_present',
      label: 'Required content present',
      ok: contentOk,
      failures: cap(contentFailures),
    },
  ];

  // Defence-in-depth — if the rubric grows new criteria, the report
  // would silently drop them. Verify shape parity here so a missing
  // criterion fails loudly at runtime (rather than producing a quietly
  // incomplete eval report).
  if (results.length !== STRUCTURAL_CRITERIA.length) {
    throw new Error(
      '[evals/structural] rubric/structural-scorer drift: rubric has ' +
        STRUCTURAL_CRITERIA.length +
        ' criteria but scorer emits ' +
        results.length +
        '. Update scoreStructural() when adding a new structural criterion.',
    );
  }

  const passedCount = results.filter((r) => r.ok).length;

  return {
    caseId: caseDef.id,
    rubricVersion,
    criteria: results,
    fileFindings,
    filesEvaluated: files.length,
    passedCount,
    totalCount: results.length,
    allOk: passedCount === results.length,
  };
}
