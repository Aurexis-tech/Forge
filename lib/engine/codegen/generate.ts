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
  CODEGEN_SYSTEM_PROMPT,
  buildCodegenRepairMessage,
  buildCodegenUserMessage,
} from './prompts';
import { resolveScaffold, type ScaffoldFile } from './scaffold';
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
    const sc = await staticCheckFile(f.path, f.content);
    if (!sc.ok) {
      warnings.push(
        "Scaffold file '" + f.path + "' failed static check — this is a Forge bug.",
      );
    }
    scaffoldWithChecks.push({
      path: f.path,
      content: f.content,
      source: 'scaffold',
      bytes: byteLength(f.content),
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
  const userMessage = buildCodegenUserMessage({
    spec: args.spec,
    plan: args.plan,
    toolInterface: args.toolInterface,
    filePath: args.filePath,
    filePurpose: args.filePurpose,
    allFiles: args.allFiles,
  });

  // --- Pass 1 ---
  const first = await complete({
    model: CODEGEN_MODEL,
    system: CODEGEN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 4000,
    governance: { ...args.governance, ref: (args.governance.ref ?? 'codegen') + '.pass1' },
  });

  const content1 = sanitiseFileOutput(first.text);
  const check1 = await staticCheckFile(args.filePath, content1);
  if (check1.ok) {
    return {
      content: content1,
      usage: first.usage,
      model: first.model,
      attempts: 1,
      staticCheck: check1,
    };
  }

  // --- Repair retry ---
  const repair = await complete({
    model: CODEGEN_MODEL,
    system: CODEGEN_SYSTEM_PROMPT,
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

  return {
    content: content2,
    usage: sumUsage(first.usage, repair.usage),
    model: repair.model,
    attempts: 2,
    staticCheck: check2,
  };
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
