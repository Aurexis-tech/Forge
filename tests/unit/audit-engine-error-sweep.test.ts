// Audit-enrichment sweep verification.
//
// The audit-enrichment sweep adds `auditEngineError({...})` to every
// engine catch site so failures across all 4 molds (agent / system /
// software / infrastructure) classify uniformly. The classifier
// keys (engine_error_category / _code / _user_message) land in
// audit_log.detail — that's what the Forge timeline + the timeline
// panel read to highlight error rows with the safe userMessage.
//
// If a future refactor removes the auditEngineError call from one
// of these catch sites, the timeline silently loses category for
// that lane. We don't want that to happen unnoticed, so this test
// scans every sweep'd route file and asserts:
//
//   1. The file imports `auditEngineError` from the helper module.
//   2. The file calls `auditEngineError` at least once (which only
//      ever lives inside a catch block by convention).
//   3. The call carries an `action: '<lane>.<verb>'` string — the
//      verb that lands on the audit row.
//
// This is a STATIC shape test (read + regex), not a per-route
// integration test. It compensates for the absence of catch-side
// integration coverage for 16 different routes by guarding the
// wiring itself. Cheap to run, fast to fail.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

interface SweepCase {
  /** Route file path relative to the repo root. */
  readonly file: string;
  /**
   * The audit_log `action` verb the sweep should record in this
   * route's catch block. Each unique lane carries its own verb so
   * downstream filtering (e.g. "show system codegen failures")
   * works.
   */
  readonly action: string;
}

// The 15 sweep'd routes + the 1 representative site from Prompt 10.
// If a new engine catch site is added, it should be appended here
// at the same time auditEngineError is wired in.
const SWEEP_CASES: ReadonlyArray<SweepCase> = [
  // Phase 1 (agent) — codegen / sandbox / push / deploy.
  { file: 'app/api/projects/[id]/build/generate/route.ts', action: 'codegen.run_failed' },
  { file: 'app/api/projects/[id]/build/test/route.ts', action: 'sandbox.run_failed' },
  { file: 'app/api/projects/[id]/build/push/route.ts', action: 'repo.push_failed' },
  { file: 'app/api/projects/[id]/build/deploy/route.ts', action: 'deploy.failed' },
  // Phase 2 (system).
  { file: 'app/api/projects/[id]/system/build/generate/route.ts', action: 'system.codegen_failed' },
  { file: 'app/api/projects/[id]/system/build/test/route.ts', action: 'system.sandbox_failed' },
  { file: 'app/api/projects/[id]/system/build/push/route.ts', action: 'system.push_failed' },
  { file: 'app/api/projects/[id]/system/build/deploy/route.ts', action: 'system.deploy_failed' },
  // Phase 3 (software).
  { file: 'app/api/projects/[id]/software/build/generate/route.ts', action: 'software.codegen_failed' },
  { file: 'app/api/projects/[id]/software/build/test/route.ts', action: 'software.sandbox_failed' },
  { file: 'app/api/projects/[id]/software/build/push/route.ts', action: 'software.push_failed' },
  { file: 'app/api/projects/[id]/software/build/deploy/route.ts', action: 'software.deploy_failed' },
  // Phase 4 (infrastructure).
  { file: 'app/api/projects/[id]/infra/build/apply/route.ts', action: 'infra.apply_failed' },
  { file: 'app/api/projects/[id]/infra/build/destroy/route.ts', action: 'infra.destroy_failed' },
  // Spec extractor + runtime tick.
  { file: 'app/api/projects/[id]/spec/generate/route.ts', action: 'spec.extract_failed' },
  { file: 'app/api/projects/[id]/runtime/run-now/route.ts', action: 'runtime.tick_failed' },
];

async function readRoute(rel: string): Promise<string> {
  const abs = path.join(PROJECT_ROOT, rel);
  return readFile(abs, 'utf8');
}

// ===========================================================================
// IMPORT
// ===========================================================================
describe('audit-enrichment sweep — auditEngineError import', () => {
  for (const c of SWEEP_CASES) {
    it(c.file + ' imports auditEngineError', async () => {
      const src = await readRoute(c.file);
      // Either `import { auditEngineError } from '...'` or
      // `import { auditEngineError, ... }` form.
      expect(src).toMatch(
        /import\s*\{[^}]*\bauditEngineError\b[^}]*\}\s*from\s*['"]@\/lib\/engine\/observability\/audit-engine-error['"]/,
      );
    });
  }
});

// ===========================================================================
// INVOCATION
// ===========================================================================
describe('audit-enrichment sweep — auditEngineError invocation', () => {
  for (const c of SWEEP_CASES) {
    it(c.file + " invokes auditEngineError with action '" + c.action + "'", async () => {
      const src = await readRoute(c.file);
      // Match a multi-line `auditEngineError({ ... action: '<verb>' ... })`
      // call. The argument object can span lines, so use a permissive
      // wildcard that does not cross another call boundary by relying
      // on `[^}]*` (object-body content).
      const re = new RegExp(
        "auditEngineError\\(\\s*\\{[^}]*action\\s*:\\s*['\"]" +
          c.action.replace(/[.\\]/g, '\\$&') +
          "['\"][^}]*\\}",
        's',
      );
      expect(src).toMatch(re);
    });
  }
});

// ===========================================================================
// CATCH-BLOCK CO-LOCATION
//
// Defence-in-depth: the helper is only meaningful inside a `catch`
// block, where there is a real classified error to attach. A bare
// auditEngineError call outside any catch block is a smell. We
// don't enforce strict catch-co-location per-call (callers
// occasionally pre-classify and pass a known error), but we DO
// assert each sweep'd file contains at least one `catch (` block,
// since the call only fires on the failure path.
// ===========================================================================
describe('audit-enrichment sweep — catch-block presence', () => {
  for (const c of SWEEP_CASES) {
    it(c.file + ' has a catch block (where the audit call belongs)', async () => {
      const src = await readRoute(c.file);
      expect(src).toMatch(/catch\s*\(/);
    });
  }
});

// ===========================================================================
// EVERY SWEEP'D ROUTE HAS A UNIQUE ACTION VERB
//
// Two routes can share a category, but the action verb identifies
// the lane on the timeline. Duplicates make the timeline
// non-actionable.
// ===========================================================================
describe('audit-enrichment sweep — action verbs are unique', () => {
  it('every (file, action) pair is distinct', () => {
    const verbs = new Set<string>();
    for (const c of SWEEP_CASES) {
      expect(verbs.has(c.action)).toBe(false);
      verbs.add(c.action);
    }
    expect(verbs.size).toBe(SWEEP_CASES.length);
  });
});
