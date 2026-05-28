// Constants for the spec-fidelity judged tier.
// Pinned in a tiny file so changing them doesn't perturb the diff
// surface of evals/spec.ts itself.

export const SPEC_JUDGE_MODEL =
  process.env.EVAL_SPEC_JUDGE_MODEL?.trim() || 'claude-haiku-4-5';

// Per-spec character ceiling fed to the judge. Specs are bounded by
// their Zod schemas so this rarely truncates; the slack here is
// belt-and-braces.
export const SPEC_JUDGE_FILE_MAX_CHARS = 6000;
