// Codegen pipeline.
//
//   generateCode(): approved spec + plan → materialised scaffold + LLM
//                   logic, every file statically checked.
//
// HARD INVARIANT: this module never executes the generated code. The static
// check is esbuild.transform() only — syntactic parse + transpile. Anything
// that runs the code happens in the next layer (sandbox).

import {
  CODEGEN_MODEL,
  LLMError,
  complete,
  sumUsage,
  type GovernanceScope,
  type LLMUsage,
} from '../llm';
import type { AgentSpec } from '../spec/schema';
import type { BuildPlan } from '../planner/schema';
import {
  buildCodegenSystemPrompt,
  buildCodegenRepairMessage,
  buildCodegenUserMessage,
  type HandoffContract,
} from './prompts';
import {
  buildRefinementContextMessage,
  critiqueAndRefine,
  type CritiqueAuditHooks,
} from './critique';
import { resolveScaffold, type ScaffoldFile } from './scaffold';
import {
  dedupeSelectedToolNames,
  mergePackageJsonDependencies,
} from '../tools';
import {
  staticCheckFile,
  type StaticCheckResult,
} from './staticcheck';

export class CodegenError extends Error {
  readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'CodegenError';
    this.cause = opts?.cause;
  }
}

export interface GeneratedFile {
  path: string;
  content: string;
  source: 'scaffold' | 'generated';
  bytes: number;
  staticCheck: StaticCheckResult;
}

export interface CodegenSummary {
  files: GeneratedFile[];
  warnings: string[];
  usage: LLMUsage;
  attempts: number; // total LLM attempts including repair retries
  llmFilesGenerated: number;
  llmFilesFailed: number;
  models: string[];
  scaffoldId: string;
  requestedScaffoldId: string;
}

export async function generateCode(args: {
  spec: AgentSpec;
  plan: BuildPlan;
  governance: GovernanceScope;
}): Promise<CodegenSummary> {
  const { spec, plan } = args;
  const warnings: string[] = [];

  // --- 1. Materialise scaffold ---------------------------------------------
  const scaffold = resolveScaffold(plan.scaffold);
  if (scaffold.fellBack) {
    warnings.push(
      "Scaffold '" +
        scaffold.requestedId +
        "' is not yet implemented; falling back to '" +
        scaffold.id +
        "'.",
    );
  }
  const scaffoldPaths = new Set(scaffold.files.map((f) => f.path));

  // Tools this build actually uses — drives the package.json dependency
  // merge below so a build only ships deps for the tools it selected.
  // Computed early so a dependency-version conflict fails the build
  // BEFORE any LLM spend.
  const selectedToolNames = dedupeSelectedToolNames(
    plan.tools.map((t) => t.registry_id),
  );

  // Merge the selected tools' scaffoldDependencies into the base
  // package.json now — a version conflict throws a typed EngineError
  // here, before any LLM spend.
  const basePackageJson =
    scaffold.files.find((f) => f.path === 'package.json')?.content ?? null;
  const mergedPackageJson =
    basePackageJson === null
      ? null
      : mergePackageJsonDependencies(basePackageJson, selectedToolNames);

  // --- 2. Determine LLM targets --------------------------------------------
  // Every plan file that is NOT in the scaffold becomes an LLM target.
  // We also ensure plan.target.entrypoint is in the target list, so the
  // entrypoint exists even if the planner forgot to enumerate it.
  const entrypointPath = plan.target.entrypoint;
  const plannedByPath = new Map(plan.files.map((f) => [f.path, f]));

  if (!plannedByPath.has(entrypointPath) && !scaffoldPaths.has(entrypointPath)) {
    plannedByPath.set(entrypointPath, {
      path: entrypointPath,
      purpose:
        'Entrypoint dispatched by ' +
        plan.target.hosting +
        ' (' +
        plan.target.framework +
        ').',
    });
  }

  for (const f of plannedByPath.values()) {
    if (scaffoldPaths.has(f.path)) {
      warnings.push(
        "Plan file '" + f.path + "' overlaps with the scaffold; using the scaffold version.",
      );
    }
  }

  const llmTargets = Array.from(plannedByPath.values()).filter(
    (f) => !scaffoldPaths.has(f.path),
  );

  // For the prompt, give the LLM the FULL picture so it can write coherent imports.
  const allFilesForPrompt: ReadonlyArray<{
    path: string;
    purpose: string;
    source: 'scaffold' | 'generated';
  }> = [
    ...scaffold.files.map((f) => ({
      path: f.path,
      purpose: '(scaffolded boilerplate or library)',
      source: 'scaffold' as const,
    })),
    ...llmTargets.map((f) => ({
      path: f.path,
      purpose: f.purpose,
      source: 'generated' as const,
    })),
  ];

  // --- 3. Generate logic files sequentially --------------------------------
  let usage: LLMUsage = { input_tokens: 0, output_tokens: 0 };
  let attempts = 0;
  let llmFailed = 0;
  const modelsUsed = new Set<string>();
  const generatedFiles: GeneratedFile[] = [];

  for (const target of llmTargets) {
    let oneResult;
    try {
      oneResult = await generateOneAgentFile({
        spec,
        plan,
        toolInterface: scaffold.toolInterface,
        filePath: target.path,
        filePurpose: target.purpose,
        allFiles: allFilesForPrompt,
        governance: {
          ...args.governance,
          ref: (args.governance.ref ?? 'codegen') + '.' + target.path,
        },
      });
    } catch (err) {
      if (err instanceof LLMError) {
        throw new CodegenError(
          "LLM error generating '" + target.path + "': " + err.message,
          { cause: err },
        );
      }
      throw err;
    }
    usage = sumUsage(usage, oneResult.usage);
    attempts += oneResult.attempts;
    modelsUsed.add(oneResult.model);
    if (!oneResult.staticCheck.ok) llmFailed++;
    generatedFiles.push({
      path: target.path,
      content: oneResult.content,
      source: 'generated',
      bytes: byteLength(oneResult.content),
      staticCheck: oneResult.staticCheck,
    });
    if (!oneResult.staticCheck.ok) {
      warnings.push(
        "File '" +
          target.path +
          "' still failed esbuild parse after a repair retry.",
      );
    }
  }

  // --- 4. Static-check scaffold files (sanity — must always pass) ----------
  const scaffoldWithChecks: GeneratedFile[] = [];
  for (const f of scaffold.files) {
    // package.json gets the per-build merged dependencies; every other
    // scaffold file ships verbatim.
    const content =
      f.path === 'package.json' && mergedPackageJson !== null
        ? mergedPackageJson
        : f.content;
    const sc = await staticCheckFile(f.path, content);
    if (!sc.ok) {
      warnings.push(
        "Scaffold file '" + f.path + "' failed static check — this is a Forge bug.",
      );
    }
    scaffoldWithChecks.push({
      path: f.path,
      content,
      source: 'scaffold',
      bytes: byteLength(content),
      staticCheck: sc,
    });
  }

  // --- 5. Completeness vs plan.files ---------------------------------------
  const finalPaths = new Set(
    [...scaffoldWithChecks, ...generatedFiles].map((f) => f.path),
  );
  for (const f of plan.files) {
    if (!finalPaths.has(f.path)) {
      warnings.push("Planned file '" + f.path + "' was not materialised.");
    }
  }
  for (const path of finalPaths) {
    const inPlan = plannedByPath.has(path);
    const isScaffold = scaffoldPaths.has(path);
    if (!inPlan && !isScaffold) {
      warnings.push("File '" + path + "' was generated but is not in plan.files.");
    }
  }

  return {
    files: [...scaffoldWithChecks, ...generatedFiles],
    warnings,
    usage,
    attempts,
    llmFilesGenerated: llmTargets.length,
    llmFilesFailed: llmFailed,
    models: Array.from(modelsUsed),
    scaffoldId: scaffold.id,
    requestedScaffoldId: scaffold.requestedId,
  };
}

// --- Per-file generation ----------------------------------------------------
//
// `generateOneAgentFile` is the REUSABLE seam the Phase 2 system codegen
// reaches into. It generates EXACTLY ONE file for a (spec, plan, path)
// triple, runs the per-file static check (esbuild parse only — never
// executes), and offers one repair retry when the parse fails. The
// system generator calls it once per sub-agent module, synthesising a
// minimal AgentSpec + BuildPlan from each OrchestrationPlan node.
//
// Exported for reuse only. Phase 1 callers stay on `generateCode` above;
// the helper is intentionally unchanged in behaviour.

export interface GenerateOneAgentFileArgs {
  spec: AgentSpec;
  plan: BuildPlan;
  toolInterface: string;
  filePath: string;
  filePurpose: string;
  allFiles: ReadonlyArray<{
    path: string;
    purpose: string;
    source: 'scaffold' | 'generated';
  }>;
  governance: GovernanceScope;
  /**
   * Optional handoff contract — present only when this call comes
   * from the Phase 2 system codegen path (one module per node). The
   * prompt assembler renders an explicit HANDOFF CONTRACT section so
   * the per-node module is generated with its neighbours in mind.
   *
   * Phase 1 (single-agent) callers leave this undefined; the
   * assembler omits the section entirely.
   */
  handoffContract?: HandoffContract;
  /**
   * Optional audit hooks for the critique-refine gate. Wired by
   * outer callers that have supabase + project context. Without
   * hooks the gate still runs (when enabled) and threads through
   * the cost ledger, but emits no audit_log rows — useful in
   * sandbox / test contexts.
   */
  critiqueAudit?: CritiqueAuditHooks;
}

export interface GenerateOneAgentFileOutput {
  content: string;
  usage: LLMUsage;
  model: string;
  attempts: number;
  staticCheck: StaticCheckResult;
}

export async function generateOneAgentFile(
  args: GenerateOneAgentFileArgs,
): Promise<GenerateOneAgentFileOutput> {
  // Cached system block = system prompt + forge-stable reference
  // material (exemplar + scaffold interface). Byte-identical across
  // every file in this build, so cacheSystem reads it back at 0.1x on
  // files 2..N. The user message below carries only per-file variability.
  const systemPrompt = buildCodegenSystemPrompt({
    toolInterface: args.toolInterface,
  });
  const userMessage = buildCodegenUserMessage({
    spec: args.spec,
    plan: args.plan,
    filePath: args.filePath,
    filePurpose: args.filePurpose,
    allFiles: args.allFiles,
    handoffContract: args.handoffContract,
  });

  // --- Pass 1 ---
  const first = await complete({
    model: CODEGEN_MODEL,
    system: systemPrompt,
    cacheSystem: true,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 4000,
    governance: { ...args.governance, ref: (args.governance.ref ?? 'codegen') + '.pass1' },
  });

  const content1 = sanitiseFileOutput(first.text);
  const check1 = await staticCheckFile(args.filePath, content1);
  if (check1.ok) {
    // Static-check passed on pass-1 — apply the critique-refine
    // gate (no-op when CRITIQUE_GATE_ENABLED is false).
    const gated = await applyCritiqueGate({
      args,
      systemPrompt,
      userMessage,
      content: content1,
    });
    return {
      content: gated.content,
      usage: first.usage,
      model: first.model,
      attempts: 1,
      staticCheck: check1,
    };
  }

  // --- Repair retry ---
  const repair = await complete({
    model: CODEGEN_MODEL,
    system: systemPrompt,
    cacheSystem: true,
    messages: [
      { role: 'user', content: userMessage },
      { role: 'assistant', content: content1 },
      { role: 'user', content: buildCodegenRepairMessage(check1.error) },
    ],
    maxTokens: 4000,
    governance: { ...args.governance, ref: (args.governance.ref ?? 'codegen') + '.repair' },
  });

  const content2 = sanitiseFileOutput(repair.text);
  const check2 = await staticCheckFile(args.filePath, content2);

  // Critique-refine ONLY runs when the candidate passed
  // static-check. When the repair still failed (check2.ok=false),
  // we surface the broken candidate to the caller as-is — the
  // critique gate doesn't try to grade un-compilable code.
  let finalContent = content2;
  if (check2.ok) {
    const gated = await applyCritiqueGate({
      args,
      systemPrompt,
      userMessage,
      content: content2,
    });
    finalContent = gated.content;
  }

  return {
    content: finalContent,
    usage: sumUsage(first.usage, repair.usage),
    model: repair.model,
    attempts: 2,
    staticCheck: check2,
  };
}

// ---------------------------------------------------------------------------
// CRITIQUE GATE — bridges the existing per-file generator into the
// engine-owned critique-refine helper (./critique.ts). Returns the
// (possibly-refined) code; never throws — the helper falls back to
// the original on any error. Pure passthrough when the env flag is
// off.
// ---------------------------------------------------------------------------

interface ApplyCritiqueGateArgs {
  args: GenerateOneAgentFileArgs;
  /** The cached system block (system prompt + exemplar + scaffold). */
  systemPrompt: string;
  /** The exact user message used for pass-1 / repair. */
  userMessage: string;
  /** The candidate code that has already passed static-check. */
  content: string;
}

async function applyCritiqueGate(
  input: ApplyCritiqueGateArgs,
): Promise<{ content: string }> {
  const { args, systemPrompt, userMessage, content } = input;
  const result = await critiqueAndRefine({
    code: content,
    filePath: args.filePath,
    filePurpose: args.filePurpose,
    // Anchor the critic with one sentence from the spec — keeps the
    // critique grounded without re-sending the whole spec blob.
    specSummary: args.spec.goal,
    governance: args.governance,
    audit: args.critiqueAudit,
    regenerate: async ({ previousCode, critique, governance }) => {
      // Re-call the codegen pipeline using the SAME system prompt +
      // user message, plus the prior code + the critic's notes as
      // the next turn. Reuses the existing prompt context — only
      // the critique is new.
      const refine = await complete({
        model: CODEGEN_MODEL,
        system: systemPrompt,
        cacheSystem: true,
        messages: [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: previousCode },
          {
            role: 'user',
            content: buildRefinementContextMessage(critique, previousCode),
          },
        ],
        maxTokens: 4000,
        governance,
      });
      return sanitiseFileOutput(refine.text);
    },
  });
  return { content: result.code };
}

// --- Helpers ---------------------------------------------------------------

function sanitiseFileOutput(text: string): string {
  let s = text;
  const trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    s = trimmed
      .replace(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
  }
  // Drop a single trailing newline-doubling without altering meaningful content.
  return s.endsWith('\n') ? s : s + '\n';
}

function byteLength(s: string): number {
  // Buffer is a Node global; this module is server-only so it's always defined.
  return Buffer.byteLength(s, 'utf8');
}
