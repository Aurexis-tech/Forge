// Prompts for the per-file codegen LLM call.
//
// THIS FILE owns the prompt + context assembly for the SHARED
// `generateOneAgentFile` worker. Both Phase 1 (single agent) and
// Phase 2 (each system node) flow through here, so a sharpened
// prompt lifts BOTH molds in one place.
//
// What changed from the v1 blob-prompt:
//
//   - SYSTEM prompt now embeds the engine's QUALITY_BAR
//     (lib/engine/codegen/quality.ts) verbatim, so we INSTRUCT
//     against the exact bar the eval harness MEASURES against.
//
//   - The user message is a STRUCTURED set of clearly labelled
//     sections (PURPOSE / INPUTS / OUTPUTS / TOOLS / SCAFFOLD
//     INTERFACE / ROLE IN PLAN / HANDOFF CONTRACT / EXEMPLAR) —
//     not a `JSON.stringify(plan, null, 2)` blob. Richer grounding
//     = better output.
//
//   - A short WORKED EXEMPLAR shows the model a concrete module
//     that visibly satisfies the QUALITY_BAR. Few-shot anchoring
//     without biasing toward any one task.
//
//   - For SYSTEM nodes, the per-call context now ALSO carries an
//     explicit HANDOFF CONTRACT with neighbour ids + payload labels,
//     so multi-agent modules are generated with their neighbours
//     in mind.
//
// What did NOT change:
//
//   - Architecture: deterministic scaffold + per-file LLM fill,
//     esbuild static-check only, never execute, bounded self-heal,
//     governance + ledger on every complete() call. The model
//     default stays claude-sonnet-4-6.
//
//   - Output rules: ONLY the file contents — no fences, no prose.
//
//   - The repair-retry message is unchanged in shape so the
//     existing static-check + repair loop in generate.ts works
//     verbatim.

import type { AgentSpec } from '../spec/schema';
import type { BuildPlan, PlanTool } from '../planner/schema';
import { TOOL_REGISTRY } from '../planner/registry';
import { qualityBarPromptBullets, QUALITY_BAR_VERSION } from './quality';

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================
//
// Built lazily-at-module-load so the QUALITY_BAR change propagates
// without any caller having to re-import. Exported as a constant
// because every per-file call shares the same system prompt.
//
// The prompt is split into four blocks for clarity:
//   1. Sharper role.
//   2. The QUALITY_BAR (from quality.ts).
//   3. Output rules — non-negotiable framing.
//   4. Code rules — scaffold-specific conventions.
// ===========================================================================
export const CODEGEN_SYSTEM_PROMPT: string = (() => {
  const role =
    'You are the Aurexis Forge codegen worker. You are generating ONE production-grade TypeScript module of a larger, scaffolded agent project. Treat this file as code that will SHIP — not a sketch, not a stub. The project\'s package.json, tsconfig.json, runtime harness, and tool library are already in place; your job is to write the file you are asked for, fully and correctly, against the scaffold\'s declared interface.';

  const qualityBar =
    'QUALITY BAR (v' +
    QUALITY_BAR_VERSION +
    ') — your output MUST satisfy every one of these; the harness measures against the same criteria:\n' +
    qualityBarPromptBullets();

  const outputRules =
    'OUTPUT RULES — non-negotiable:\n' +
    '- Output ONLY the file contents. No prose. No markdown code fences. No commentary.\n' +
    "- Begin with the very first character of the file (e.g. `import`, `{`, `//`).\n" +
    '- Do not include the file path, do not include a "Here is the file:" preamble.\n' +
    '- Do NOT include TODO / FIXME / XXX comments anywhere — see the QUALITY BAR above.';

  const codeRules =
    'CODE RULES:\n' +
    "- ES module syntax. Local imports MUST use `.js` extensions (e.g. `import { web_search } from './lib/tools/index.js';`).\n" +
    '- TypeScript strict mode is on. Type everything; no implicit any.\n' +
    '- Use ONLY the tools exported from `./lib/tools/index.js` for capability invocations. Never reimplement web search, HTTP, LLM calls, file I/O, scheduling, or email. Never invent new tool ids.\n' +
    '- Use the runtime harness from `./lib/runtime.js` — `defineAgent`, `asApiHandler`, `asWebhookHandler`, `runChatStdin`, `runOnce`, `createContext` — for trigger plumbing.\n' +
    '- All configuration comes from `process.env`. Never hardcode API keys, URLs, sender addresses, or other secrets.\n' +
    '- Stay within the dependencies declared in package.json (@anthropic-ai/sdk) plus Node built-ins (node:fs/promises, node:path, etc).\n' +
    '- Prefer pure functions; isolate side effects in tool calls.';

  return [role, '', qualityBar, '', outputRules, '', codeRules].join('\n');
})();

// ===========================================================================
// CACHED SYSTEM BLOCK — system prompt + the FORGE-STABLE reference
// material (WORKED EXEMPLAR + SCAFFOLD INTERFACE).
// ===========================================================================
//
// PROMPT-CACHING SEAM. The worked exemplar (a global constant) and the
// scaffold interface (constant for the whole build — every file in a
// forge shares one scaffold) are reference material, not per-file
// request data. Lifting them out of the per-file user message and into
// the system block makes the system block:
//
//   - a CLEAN, DETERMINISTIC prefix (no per-file variability), and
//   - byte-IDENTICAL across every file generated in a single forge,
//
// so `complete({ cacheSystem: true })` caches it once and reads it back
// at 0.1x input price on files 2..N. Content is unchanged — the model
// still sees the exact same exemplar + interface text, just framed as
// standing context rather than repeated in each user turn.
//
// The base CODEGEN_SYSTEM_PROMPT is exported separately (above) so the
// eval/drift tests can still assert the QUALITY_BAR is embedded verbatim.
export function buildCodegenSystemPrompt(args: {
  toolInterface: string;
}): string {
  return [
    CODEGEN_SYSTEM_PROMPT,
    '',
    sectionExemplar(),
    '',
    sectionScaffoldInterface(args.toolInterface),
  ].join('\n');
}

// ===========================================================================
// USER MESSAGE — STRUCTURED CONTEXT
// ===========================================================================
//
// Each section is built by a small pure function so the unit test
// can call them individually if needed. The assembler concatenates
// them in a fixed order separated by blank lines.
// ===========================================================================

/**
 * Per-node handoff contract — present ONLY for Phase 2 system-node
 * generation calls. Phase 1 single-agent calls leave this undefined,
 * and the assembler omits the HANDOFF CONTRACT section entirely.
 *
 * The orchestrator enforces this contract at runtime regardless;
 * surfacing it explicitly in the prompt makes the module aware of
 * who hands it data and who consumes its output, which empirically
 * cuts down on "module ignores its inputs" failures.
 */
export interface HandoffContract {
  /** The id of THIS node — same as the synthesised agent name. */
  readonly selfNodeId: string;
  /** Predecessor handoffs feeding this node. */
  readonly upstream: ReadonlyArray<{
    /** Source node id, or null when the input originates from the trigger payload. */
    readonly fromNodeId: string | null;
    /** Short label describing the payload crossing the wire. */
    readonly payload: string;
  }>;
  /** Downstream nodes that consume this module's outputs. */
  readonly downstream: ReadonlyArray<{
    readonly toNodeId: string;
    readonly payload: string;
  }>;
  /** Output keys the orchestrator will read off this module's return value. */
  readonly declaredOutputs: ReadonlyArray<string>;
}

export interface CodegenUserMessageArgs {
  spec: AgentSpec;
  plan: BuildPlan;
  filePath: string;
  filePurpose: string;
  allFiles: ReadonlyArray<{
    path: string;
    purpose: string;
    source: 'scaffold' | 'generated';
  }>;
  /** Present for system-node generation; omitted for Phase 1 agent files. */
  handoffContract?: HandoffContract;
}

// The per-file VARIABLE message. The forge-stable reference blocks
// (WORKED EXEMPLAR + SCAFFOLD INTERFACE) now live in the cached system
// block (buildCodegenSystemPrompt) — see the caching note there — so
// this message carries only what changes per file. That keeps the
// cached prefix deterministic and the variable content strictly after
// the cache breakpoint.
export function buildCodegenUserMessage(args: CodegenUserMessageArgs): string {
  // Sections in a fixed order. Each section returns a labelled block;
  // null sections (e.g. handoff contract on Phase 1 calls) are dropped.
  const sections: Array<string | null> = [
    sectionPurpose(args),
    sectionInputs(args.spec),
    sectionOutputs(args.spec),
    sectionTools(args.spec, args.plan),
    sectionPlanRole(args),
    args.handoffContract ? sectionHandoff(args.handoffContract) : null,
    sectionFinalInstruction(args),
  ];
  return sections.filter((s): s is string => s !== null).join('\n\n');
}

// ---------------------------------------------------------------------------
// PURPOSE — what this file does, why it exists.
// ---------------------------------------------------------------------------
function sectionPurpose(args: CodegenUserMessageArgs): string {
  return [
    'PURPOSE',
    '  This file: ' + args.filePath,
    '  Project goal: ' + args.spec.goal,
    '  File purpose: ' + args.filePurpose,
    '  Project description: ' + args.spec.description,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// INPUTS — typed list with descriptions, surfaced explicitly so the
// model wires the function signature against them.
// ---------------------------------------------------------------------------
function sectionInputs(spec: AgentSpec): string {
  if (spec.inputs.length === 0) {
    return [
      'INPUTS',
      '  (none declared — this file should not assume payload fields)',
    ].join('\n');
  }
  const lines = spec.inputs.map(
    (i) => '  - ' + i.name + ' :: ' + i.description,
  );
  return ['INPUTS', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// OUTPUTS — declared keys on the returned object. The system codegen
// path SURFACES this so each node's module produces exactly the keys
// the orchestrator expects; the orchestrator validates the handoff
// regardless, but instructing the model up front avoids the retry.
// ---------------------------------------------------------------------------
function sectionOutputs(spec: AgentSpec): string {
  if (spec.outputs.length === 0) {
    return [
      'OUTPUTS',
      '  (none declared — return a minimal status shape, e.g. { ok: true })',
    ].join('\n');
  }
  const lines = spec.outputs.map(
    (o) => '  - ' + o.name + ' :: ' + o.description,
  );
  return ['OUTPUTS', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// TOOLS — what the file may CALL. We surface the resolved registry
// signature (label + env_keys) so the model sees the contract, not
// just the id. Full signatures live in SCAFFOLD INTERFACE below.
// ---------------------------------------------------------------------------
function sectionTools(spec: AgentSpec, plan: BuildPlan): string {
  if (plan.tools.length === 0) {
    return [
      'TOOLS AVAILABLE',
      '  (none declared — this file performs no tool calls)',
    ].join('\n');
  }
  // Look up each plan tool against the live registry so the prompt
  // reflects what's actually wired. Tools the planner marked
  // 'unsupported' surface with a warning.
  const lines: string[] = ['TOOLS AVAILABLE'];
  for (const t of plan.tools) {
    lines.push(renderTool(t, spec));
  }
  return lines.join('\n');
}

function renderTool(t: PlanTool, spec: AgentSpec): string {
  const why =
    spec.capabilities.find((c) => c.tool === t.requested)?.why ?? null;
  if (t.status === 'unsupported') {
    return (
      '  - ' +
      t.requested +
      '  [UNSUPPORTED — do not use this tool; the planner could not ground it]'
    );
  }
  const entry = TOOL_REGISTRY.find((r) => r.id === t.registry_id);
  const env =
    t.env_keys.length === 0
      ? 'no env required'
      : 'env: ' + t.env_keys.join(', ');
  const label = entry ? entry.label : '(no registry entry)';
  const description = entry ? entry.description : '';
  const whyTail = why ? '  // why: ' + why : '';
  return (
    '  - ' +
    (t.registry_id ?? t.requested) +
    '  [' +
    label +
    '; ' +
    env +
    '] — ' +
    description +
    whyTail
  );
}

// ---------------------------------------------------------------------------
// SCAFFOLD INTERFACE — the EXACT exported surface the file may import
// from the scaffold. The interface text is produced by the scaffold
// itself (lib/engine/codegen/scaffold/<id>.ts) and includes type
// signatures for every tool. This is the contract the file must
// satisfy.
// ---------------------------------------------------------------------------
function sectionScaffoldInterface(toolInterface: string): string {
  return [
    'SCAFFOLD INTERFACE (the only modules you may import from this project — exact contract):',
    toolInterface.trim(),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// PLAN ROLE — where this file fits in the build. Surfaces the
// declared tasks + the full file list so the model can reason about
// imports across the project.
// ---------------------------------------------------------------------------
function sectionPlanRole(args: CodegenUserMessageArgs): string {
  const fileLines = args.allFiles.map(
    (f) => '  - ' + f.path + '  [' + f.source + ']: ' + f.purpose,
  );
  const taskLines = args.plan.tasks.map(
    (t) =>
      '  - ' +
      t.id +
      ' :: ' +
      t.title +
      (t.depends_on.length > 0
        ? ' (after: ' + t.depends_on.join(', ') + ')'
        : ''),
  );
  return [
    'ROLE IN PLAN',
    '  Scaffold: ' + args.plan.scaffold,
    '  Target framework: ' +
      args.plan.target.framework +
      ' / hosting: ' +
      args.plan.target.hosting +
      ' / entrypoint: ' +
      args.plan.target.entrypoint,
    '  Trigger impl: ' + args.plan.trigger_impl,
    '  Runtime impl: ' + args.plan.runtime_impl,
    '  Plan tasks:',
    ...taskLines,
    '  All files in this build (you are generating ONE of these):',
    ...fileLines,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// HANDOFF CONTRACT — Phase 2 system nodes only. Spells out the data
// pipeline this module participates in.
// ---------------------------------------------------------------------------
function sectionHandoff(h: HandoffContract): string {
  const upstream =
    h.upstream.length === 0
      ? '  upstream: (none — first node in the pipeline)'
      : '  upstream (these nodes hand you data):\n' +
        h.upstream
          .map(
            (u) =>
              '    - from ' +
              (u.fromNodeId ?? '(external trigger)') +
              ' :: ' +
              u.payload,
          )
          .join('\n');
  const downstream =
    h.downstream.length === 0
      ? '  downstream: (none — last node in the pipeline)'
      : '  downstream (these nodes consume your output):\n' +
        h.downstream
          .map((d) => '    - to ' + d.toNodeId + ' :: ' + d.payload)
          .join('\n');
  const outputs =
    h.declaredOutputs.length === 0
      ? '  declared outputs: (none)'
      : '  declared outputs (your returned object MUST include every key): ' +
        h.declaredOutputs.join(', ');
  return [
    "HANDOFF CONTRACT (this module is node '" + h.selfNodeId + "' in a multi-agent system)",
    upstream,
    downstream,
    outputs,
    "  Export the contract: an async function `run(input: Record<string, unknown>): Promise<Record<string, unknown>>` that returns the declared outputs. Do NOT import sibling modules directly — the orchestrator wires the pipeline.",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// WORKED EXEMPLAR — a short module that visibly satisfies the
// QUALITY_BAR. Deliberately generic (no web search, no scheduling)
// so the model anchors on STYLE without biasing toward a task.
// ---------------------------------------------------------------------------
function sectionExemplar(): string {
  return [
    'WORKED EXEMPLAR (illustrative only — DO NOT COPY VERBATIM; mirror the style + quality)',
    '```',
    "// src/lib/normalise-name.ts (example, NOT a file to emit)",
    "import { llm_completion } from './tools/index.js';",
    "import { createContext, type ToolContext } from './tools/types.js';",
    '',
    'export interface NormaliseNameInput {',
    '  readonly raw: string;',
    '  readonly locale?: string;',
    '}',
    '',
    'export interface NormaliseNameOutput {',
    "  readonly canonical: string;",
    "  readonly source: 'rule' | 'llm';",
    '}',
    '',
    'export async function normaliseName(',
    '  input: NormaliseNameInput,',
    '  ctx: ToolContext = createContext(),',
    '): Promise<NormaliseNameOutput> {',
    '  const raw = input.raw.trim();',
    '  if (!raw) {',
    "    throw new Error('normaliseName: input.raw must be a non-empty string');",
    '  }',
    '',
    '  // Cheap rule-based path first — only escalate to the LLM when ambiguous.',
    '  const simple = raw.split(/\\s+/).map(titleCase).join(\' \');',
    '  if (!hasAmbiguity(simple)) {',
    "    return { canonical: simple, source: 'rule' };",
    '  }',
    '',
    '  try {',
    '    const result = await llm_completion.call(',
    "      { user: 'Normalise this name: ' + raw, maxTokens: 80 },",
    '      ctx,',
    '    );',
    "    return { canonical: result.text.trim(), source: 'llm' };",
    '  } catch (err) {',
    '    throw new Error(',
    "      'normaliseName: llm_completion failed for raw=' + JSON.stringify(raw) +",
    "        ': ' + (err instanceof Error ? err.message : 'unknown error'),",
    '    );',
    '  }',
    '}',
    '',
    'function titleCase(s: string): string {',
    "  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase();",
    '}',
    '',
    'function hasAmbiguity(s: string): boolean {',
    '  return /\\s/.test(s) && s.length > 30;',
    '}',
    '```',
    '',
    'Notice: typed inputs/outputs, input validation, named errors with context, real branching (not a stub), only declared imports, no TODOs, no dead code.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// FINAL INSTRUCTION — closes the prompt with the exact ask.
// ---------------------------------------------------------------------------
function sectionFinalInstruction(args: CodegenUserMessageArgs): string {
  return [
    'GENERATE THIS FILE NOW',
    '  Path:    ' + args.filePath,
    '  Purpose: ' + args.filePurpose,
    '',
    'Output ONLY the file contents. Begin immediately with the first character of the file. No fences. No commentary.',
  ].join('\n');
}

// ===========================================================================
// REPAIR MESSAGE — unchanged in shape; the static-check + repair
// loop in generate.ts feeds this back when esbuild rejected the
// first attempt. We keep the body terse so the model focuses on
// the offending lines rather than re-narrating.
// ===========================================================================
export function buildCodegenRepairMessage(error: string): string {
  return [
    'esbuild rejected your previous output:',
    '',
    error,
    '',
    'Return ONLY the corrected file content. No prose. No markdown code fences. Keep the file purpose, exports, and imports intact; fix the offending lines while still meeting the QUALITY BAR you were given.',
  ].join('\n');
}
