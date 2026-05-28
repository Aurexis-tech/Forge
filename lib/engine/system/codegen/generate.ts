// Aurexis Forge — Phase 2 (Systems) codegen pipeline.
//
//   generateSystemCode(): confirmed SystemSpec + approved OrchestrationPlan
//                         → materialised scaffold + deterministic orchestrator
//                           + one LLM-generated module per node (per-file static
//                           check, never executed).
//
// REUSE — the per-node module is produced by the REUSED Phase 1 agent
// generator (`generateOneAgentFile` exported from lib/engine/codegen/generate.ts).
// The node is adapted to the agent generator's input contract by
// synthesising a minimal AgentSpec + BuildPlan from the OrchestrationPlan
// node — same prompt, same per-file static check, same repair retry.
//
// HARD INVARIANT: this module NEVER executes generated code. The static
// check is esbuild.transform() only — identical to Phase 1. Sandbox
// execution is a future layer (P2-4) and is NOT added in this prompt.

import {
  generateOneAgentFile,
  type CodegenSummary,
  type GeneratedFile,
} from '@/lib/engine/codegen/generate';
import type { HandoffContract } from '@/lib/engine/codegen/prompts';
import { LLMError, sumUsage, type GovernanceScope, type LLMUsage } from '@/lib/engine/llm';
import { resolveScaffold } from '@/lib/engine/codegen/scaffold';
import {
  staticCheckFile,
  type StaticCheckResult,
} from '@/lib/engine/codegen/staticcheck';
import {
  dedupeSelectedToolNames,
  mergePackageJsonDependencies,
} from '@/lib/engine/tools';
import { TOOL_REGISTRY } from '@/lib/engine/planner/registry';
import {
  AgentSpecSchema,
  type AgentSpec,
} from '@/lib/engine/spec/schema';
import {
  BuildPlanSchema,
  type BuildPlan,
  type PlanTool,
} from '@/lib/engine/planner/schema';
import type { SystemSpec } from '../spec';
import type {
  OrchestrationPlan,
  OrchestrationNode,
} from '../planner/schema';
import {
  generateOrchestratorSource,
  generateSystemEntrypointSource,
} from './orchestrator';

export class SystemCodegenError extends Error {
  readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'SystemCodegenError';
    this.cause = opts?.cause;
  }
}

export interface SystemModuleResult {
  readonly nodeId: string;
  readonly path: string;
  readonly attempts: number;
  readonly model: string;
  readonly usage: LLMUsage;
  readonly staticCheckOk: boolean;
}

export interface SystemCodegenSummary {
  readonly files: GeneratedFile[];
  readonly warnings: string[];
  readonly usage: LLMUsage;
  readonly attempts: number;
  readonly modulesGenerated: number;
  readonly modulesFailed: number;
  readonly orchestratorPath: string;
  readonly entrypointPath: string;
  readonly modelsUsed: string[];
  readonly perModule: SystemModuleResult[];
  readonly scaffoldId: string;
}

// Mirror the Phase 1 `CodegenSummary` shape for the persistence layer.
// Lets us reuse `storeBuildFiles` + `completeCodegen`-style logging
// without re-modelling. The shape is intentionally additive — we don't
// touch the Phase 1 type itself.
export interface SystemCodegenForPersistence
  extends Pick<
    CodegenSummary,
    'files' | 'warnings' | 'usage' | 'attempts' | 'models' | 'scaffoldId'
  > {
  readonly modulesGenerated: number;
  readonly modulesFailed: number;
  readonly orchestratorPath: string;
  readonly entrypointPath: string;
  readonly perModule: SystemModuleResult[];
}

export async function generateSystemCode(args: {
  spec: SystemSpec;
  plan: OrchestrationPlan;
  governance: GovernanceScope;
}): Promise<SystemCodegenSummary> {
  const { spec, plan } = args;
  const warnings: string[] = [];

  // --- 1. Materialise the shared scaffold ONCE -----------------------------
  // Every Phase 2 system project ships the same Phase 1 scaffold so the
  // per-node module can use the existing tool library + runtime harness.
  // Scaffold files are checked here for completeness; the LLM never
  // touches them.
  const scaffold = resolveScaffold('agent-node-tool-using');

  // Tools this system build actually uses = union of every node's
  // suggested tools. Drives the per-build package.json dependency
  // merge so a system ships only the deps its nodes need. A version
  // conflict throws a typed EngineError before any LLM spend.
  const selectedToolNames = dedupeSelectedToolNames(
    plan.nodes.flatMap((n) => n.suggested_tools.map((t) => t.registry_id)),
  );
  const basePackageJson =
    scaffold.files.find((f) => f.path === 'package.json')?.content ?? null;
  const mergedPackageJson =
    basePackageJson === null
      ? null
      : mergePackageJsonDependencies(basePackageJson, selectedToolNames);

  const scaffoldWithChecks: GeneratedFile[] = [];
  for (const f of scaffold.files) {
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

  // --- 2. Deterministic orchestrator + entrypoint --------------------------
  // The orchestrator embeds the max-steps ceiling + handoff validation
  // (the two Phase 2 non-negotiables). Both files are pure templates —
  // no LLM call, no execution.
  const orchestrator = generateOrchestratorSource(spec, plan);
  const entrypoint = generateSystemEntrypointSource();

  const orchestratorCheck = await staticCheckFile(orchestrator.path, orchestrator.content);
  if (!orchestratorCheck.ok) {
    // A failed static check on the deterministic orchestrator means
    // the template itself is broken — surface loud, don't continue.
    throw new SystemCodegenError(
      "deterministic orchestrator failed esbuild parse: " + orchestratorCheck.error,
    );
  }
  const entrypointCheck = await staticCheckFile(entrypoint.path, entrypoint.content);
  if (!entrypointCheck.ok) {
    throw new SystemCodegenError(
      "deterministic system entrypoint failed esbuild parse: " + entrypointCheck.error,
    );
  }

  const orchestratorFile: GeneratedFile = {
    path: orchestrator.path,
    content: orchestrator.content,
    source: 'generated',
    bytes: byteLength(orchestrator.content),
    staticCheck: orchestratorCheck,
  };
  const entrypointFile: GeneratedFile = {
    path: entrypoint.path,
    content: entrypoint.content,
    source: 'generated',
    bytes: byteLength(entrypoint.content),
    staticCheck: entrypointCheck,
  };

  // --- 3. Per-node modules via the reused Phase 1 agent generator ---------
  // For each node we synthesise a narrow AgentSpec + BuildPlan, then
  // call `generateOneAgentFile` once to produce that node's
  // `src/modules/<id>/index.ts`. Every per-node LLM call inherits the
  // Phase 1 governance guard + ledger + BYOK resolution unchanged.
  const moduleFiles: GeneratedFile[] = [];
  const perModule: SystemModuleResult[] = [];
  let totalUsage: LLMUsage = { input_tokens: 0, output_tokens: 0 };
  let totalAttempts = 0;
  let modulesFailed = 0;
  const modelsUsed = new Set<string>();

  // Build the "all files in this build" list once — the per-node prompt
  // includes it so the LLM can reason about imports across the whole
  // system, not just its own module.
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
    {
      path: orchestrator.path,
      purpose:
        'Generated orchestrator (deterministic). Imports each module and walks the execution_order with handoff validation + max-steps ceiling.',
      source: 'generated' as const,
    },
    {
      path: entrypoint.path,
      purpose:
        'Generated entrypoint (deterministic). Parses an argv JSON payload and calls orchestrate().',
      source: 'generated' as const,
    },
    ...plan.nodes.map((n) => ({
      path: moduleFilePath(n.id),
      purpose: moduleFilePurpose(n),
      source: 'generated' as const,
    })),
  ];

  for (const node of plan.nodes) {
    const oneResult = await generateOneSystemNodeModule({
      node,
      spec,
      plan,
      governance: args.governance,
      // First-pass generation: reuse the file list we already built so
      // the LLM sees the full project layout, not just one module.
      scaffoldOverride: scaffold,
      allFilesForPromptOverride: allFilesForPrompt,
    });

    totalUsage = sumUsage(totalUsage, oneResult.usage);
    totalAttempts += oneResult.attempts;
    modelsUsed.add(oneResult.model);
    if (!oneResult.staticCheckOk) {
      modulesFailed++;
      warnings.push(
        "Module for node '" + node.id + "' still failed esbuild parse after a repair retry.",
      );
    }
    moduleFiles.push({
      path: oneResult.file.path,
      content: oneResult.file.content,
      source: 'generated',
      bytes: oneResult.file.bytes,
      staticCheck: oneResult.file.staticCheck,
    });
    perModule.push({
      nodeId: node.id,
      path: oneResult.file.path,
      attempts: oneResult.attempts,
      model: oneResult.model,
      usage: oneResult.usage,
      staticCheckOk: oneResult.staticCheckOk,
    });
  }

  // --- 4. Final assembly --------------------------------------------------
  const files: GeneratedFile[] = [
    ...scaffoldWithChecks,
    orchestratorFile,
    entrypointFile,
    ...moduleFiles,
  ];

  return {
    files,
    warnings,
    usage: totalUsage,
    attempts: totalAttempts,
    modulesGenerated: plan.nodes.length,
    modulesFailed,
    orchestratorPath: orchestrator.path,
    entrypointPath: entrypoint.path,
    modelsUsed: Array.from(modelsUsed),
    perModule,
    scaffoldId: scaffold.id,
  };
}

// ---------------------------------------------------------------------------
// Per-node generation seam. Used both by the full codegen pass above
// AND by the sandbox self-heal in lib/engine/system/sandbox/runner.ts
// (one bounded retry that regenerates only the failing node's module).
// Keeping the per-node call here means the self-heal path inherits the
// exact same governance / repair-retry / static-check posture as the
// initial generation — no parallel implementation.
// ---------------------------------------------------------------------------

interface GenerateOneSystemNodeModuleArgs {
  node: OrchestrationNode;
  spec: SystemSpec;
  plan: OrchestrationPlan;
  governance: GovernanceScope;
  // Optional overrides used by the initial codegen pass so the LLM
  // sees the full file list. The self-heal path omits both and lets
  // us derive them locally.
  scaffoldOverride?: ReturnType<typeof resolveScaffold>;
  allFilesForPromptOverride?: ReadonlyArray<{
    path: string;
    purpose: string;
    source: 'scaffold' | 'generated';
  }>;
}

interface GenerateOneSystemNodeModuleResult {
  file: GeneratedFile;
  attempts: number;
  model: string;
  usage: LLMUsage;
  staticCheckOk: boolean;
}

export async function generateOneSystemNodeModule(
  args: GenerateOneSystemNodeModuleArgs,
): Promise<GenerateOneSystemNodeModuleResult> {
  const scaffold = args.scaffoldOverride ?? resolveScaffold('agent-node-tool-using');
  const allFilesForPrompt =
    args.allFilesForPromptOverride ?? defaultAllFilesForPrompt(scaffold, args.plan);

  const adapted = adaptNodeForAgentGenerator(args.node, args.spec);
  const targetPath = moduleFilePath(args.node.id);
  const purpose = moduleFilePurpose(args.node);
  // Build the explicit handoff contract from the plan so the per-file
  // prompt carries the neighbour info as a first-class section, not
  // buried in the synthesised AgentSpec's constraints.
  const handoffContract = deriveHandoffContract(args.node, args.plan);

  let result;
  try {
    result = await generateOneAgentFile({
      spec: adapted.spec,
      plan: adapted.plan,
      toolInterface: scaffold.toolInterface,
      filePath: targetPath,
      filePurpose: purpose,
      allFiles: allFilesForPrompt,
      handoffContract,
      governance: {
        ...args.governance,
        ref: (args.governance.ref ?? 'system.codegen') + '.module.' + args.node.id,
      },
    });
  } catch (err) {
    if (err instanceof LLMError) {
      throw new SystemCodegenError(
        "LLM error generating module for node '" + args.node.id + "': " + err.message,
        { cause: err },
      );
    }
    throw err;
  }

  return {
    file: {
      path: targetPath,
      content: result.content,
      source: 'generated',
      bytes: byteLength(result.content),
      staticCheck: result.staticCheck,
    },
    attempts: result.attempts,
    model: result.model,
    usage: result.usage,
    staticCheckOk: result.staticCheck.ok,
  };
}

function defaultAllFilesForPrompt(
  scaffold: ReturnType<typeof resolveScaffold>,
  plan: OrchestrationPlan,
): ReadonlyArray<{
  path: string;
  purpose: string;
  source: 'scaffold' | 'generated';
}> {
  return [
    ...scaffold.files.map((f) => ({
      path: f.path,
      purpose: '(scaffolded boilerplate or library)',
      source: 'scaffold' as const,
    })),
    {
      path: 'src/orchestrator.ts',
      purpose:
        'Generated orchestrator (deterministic). Imports each module and walks the execution_order with handoff validation + max-steps ceiling.',
      source: 'generated' as const,
    },
    {
      path: 'src/index.ts',
      purpose:
        'Generated entrypoint (deterministic). Parses an argv JSON payload and calls orchestrate().',
      source: 'generated' as const,
    },
    ...plan.nodes.map((n) => ({
      path: moduleFilePath(n.id),
      purpose: moduleFilePurpose(n),
      source: 'generated' as const,
    })),
  ];
}

// Public seam for the sandbox self-heal — regenerate exactly one
// node's module. Returns the file ready to be written into the
// sandbox + persisted as a build_files row. Same per-file governance
// + repair retry as the initial pass; one extra LLM call, hard-capped
// at one retry by the caller (the runner gates on iterations).
export async function regenerateSystemModule(args: {
  spec: SystemSpec;
  plan: OrchestrationPlan;
  nodeId: string;
  governance: GovernanceScope;
}): Promise<GenerateOneSystemNodeModuleResult> {
  const node = args.plan.nodes.find((n) => n.id === args.nodeId);
  if (!node) {
    throw new SystemCodegenError(
      "regenerateSystemModule: no node '" + args.nodeId + "' in plan",
    );
  }
  return generateOneSystemNodeModule({
    node,
    spec: args.spec,
    plan: args.plan,
    governance: {
      ...args.governance,
      ref: (args.governance.ref ?? 'system.codegen.selfheal') + '.' + args.nodeId,
    },
  });
}

// ---------------------------------------------------------------------------
// Per-node adapter — turn an OrchestrationNode into a narrow AgentSpec +
// BuildPlan that satisfies the Phase 1 schema, so `generateOneAgentFile`
// can be called as-is. The synthesised spec/plan is for PROMPT-CONTEXT
// only; nothing is persisted from it. We re-validate against the Phase
// 1 schemas at the end of this function so any drift in those schemas
// surfaces here rather than producing a malformed LLM prompt.
// ---------------------------------------------------------------------------

interface AdaptedAgentInput {
  spec: AgentSpec;
  plan: BuildPlan;
}

function adaptNodeForAgentGenerator(
  node: OrchestrationNode,
  spec: SystemSpec,
): AdaptedAgentInput {
  // Map the node's suggested_tools onto Phase 1 PlanTools. The shape
  // already matches (same fields, same statuses); we just narrow the
  // type and surface env_keys.
  const tools: PlanTool[] = node.suggested_tools.map((t) => ({
    requested: t.requested,
    status: t.status,
    registry_id: t.registry_id,
    env_keys: t.env_keys,
  }));

  // env_required derived from the suggested_tools — the registry is the
  // source of truth for which keys are actually needed, so we re-check
  // and emit one entry per (tool, env_key) pair.
  const envSet = new Set<string>();
  const envRequired: BuildPlan['env_required'] = [];
  for (const t of tools) {
    if (t.registry_id === null) continue;
    const entry = TOOL_REGISTRY.find((r) => r.id === t.registry_id);
    if (!entry) continue;
    for (const key of t.env_keys) {
      if (!envSet.has(key) && entry.env_keys.includes(key)) {
        envSet.add(key);
        envRequired.push({
          key,
          why:
            'Required by tool ' + t.registry_id + " used in node '" + node.id + "'.",
          secret: true,
        });
      }
    }
  }

  // capabilities — one per supported/needs_key tool. The agent generator
  // uses these to inform the LLM what's available; node.task already
  // tells the LLM what the module should DO.
  const capabilities: AgentSpec['capabilities'] = tools
    .filter((t) => t.status !== 'unsupported' && t.registry_id !== null)
    .map((t) => ({
      tool: t.registry_id as string,
      why: "Used by node '" + node.id + "' (" + node.role + ').',
    }));

  // inputs/outputs — describe the handoff contract in plain language so
  // the prompt carries it. The orchestrator enforces the contract at
  // runtime regardless of what the module believes about it.
  const inputs: AgentSpec['inputs'] = node.inputs.map((h) => ({
    name: h.output,
    description:
      h.from === null
        ? "External input '" + h.output + "' (handed in by the orchestrator from the trigger payload)."
        : "Output '" + h.output + "' produced by upstream node '" + h.from + "'.",
  }));
  const outputs: AgentSpec['outputs'] = node.outputs.map((o) => ({
    name: o,
    description: "Output key '" + o + "' on the returned object.",
  }));

  // The synthesised AgentSpec. Trigger is 'api' — modules are invoked
  // by the orchestrator, semantically the closest existing trigger to
  // "synchronous call with a payload". Runtime is 'on_demand' — a
  // module never has its own scheduler; the system as a whole owns the
  // trigger.
  const agentSpecCandidate: AgentSpec = {
    name: node.id,
    goal: node.task,
    description:
      node.role +
      ' — ' +
      node.task +
      ' (sub-agent module of the larger system: ' +
      spec.goal +
      ')',
    trigger: 'api',
    runtime: 'on_demand',
    inputs,
    capabilities,
    outputs,
    constraints: [
      'This file is a sub-agent MODULE, not a standalone agent.',
      "Export a NAMED async function `run(input: Record<string, unknown>): Promise<Record<string, unknown>>` — the orchestrator invokes this function with the upstream node's outputs already assembled into a single input object.",
      "The returned object MUST include every key declared in this node's outputs; the orchestrator validates the handoff and throws when a key is missing.",
      "Do NOT import or call other node modules directly — every cross-module communication goes through the orchestrator's typed handoff.",
      "Do NOT loop indefinitely or recurse; the orchestrator enforces a hard MAX-STEPS ceiling that counts node invocations.",
    ],
    success_criteria: [
      "Returns an object carrying all declared outputs: " +
        (node.outputs.length === 0 ? '(none)' : node.outputs.join(', ')) +
        '.',
      'Uses only the scaffold tool library (./lib/tools/index.js) and runtime harness (./lib/runtime.js); no reimplementation.',
    ],
    risk: 'low',
    confidence: 0.9,
  };

  // BuildPlan synthesised around the single module file. The agent
  // generator's prompt uses target.framework + plan.tasks + plan.files
  // to position the LLM; here we declare exactly the one file we want
  // back.
  const modulePath = moduleFilePath(node.id);
  const buildPlanCandidate: BuildPlan = {
    scaffold: 'agent-node-tool-using',
    target: {
      framework: 'node-module',
      hosting: 'worker',
      entrypoint: modulePath,
    },
    trigger_impl:
      "Invoked by the parent system's orchestrator with the upstream nodes' outputs assembled into a single input object.",
    runtime_impl: 'on_demand',
    tools,
    files: [
      {
        path: modulePath,
        purpose: moduleFilePurpose(node),
      },
    ],
    env_required: envRequired,
    tasks: [
      {
        id: 'implement_' + node.id,
        title: "Implement node '" + node.id + "'",
        description:
          'Produce the module body that fulfils the node task: ' +
          node.task,
        depends_on: [],
      },
    ],
    estimate: {
      risk: 'low',
      complexity: 'low',
      notes:
        "Single-file module. Imports the shared tool library + runtime; conforms to the orchestrator's handoff contract.",
    },
    warnings: [],
  };

  // Re-validate against the Phase 1 schemas. Drift in those schemas
  // would otherwise produce a malformed prompt that the LLM can't
  // recover from with a repair retry.
  const specParse = AgentSpecSchema.safeParse(agentSpecCandidate);
  if (!specParse.success) {
    throw new SystemCodegenError(
      "adapted AgentSpec for node '" +
        node.id +
        "' failed Phase 1 schema validation: " +
        specParse.error.issues
          .slice(0, 4)
          .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
          .join('; '),
    );
  }
  const planParse = BuildPlanSchema.safeParse(buildPlanCandidate);
  if (!planParse.success) {
    throw new SystemCodegenError(
      "adapted BuildPlan for node '" +
        node.id +
        "' failed Phase 1 schema validation: " +
        planParse.error.issues
          .slice(0, 4)
          .map((i) => (i.path.join('.') || '(root)') + ': ' + i.message)
          .join('; '),
    );
  }

  return { spec: specParse.data, plan: planParse.data };
}

// Pull the neighbour info off the OrchestrationPlan for THIS node and
// shape it into the per-call HandoffContract the prompt assembler
// consumes. Pure function — no LLM, no IO; safe to call inside the
// existing module-generation loop and from the self-heal path.
function deriveHandoffContract(
  node: OrchestrationNode,
  plan: OrchestrationPlan,
): HandoffContract {
  // node.inputs[] already carries (fromNodeId | null, output label).
  // The plan-level edges[] carry payload labels, which are richer
  // than the raw output names — surface them when we have them.
  const inboundEdges = plan.edges.filter((e) => e.to === node.id);
  const upstream: HandoffContract['upstream'] = node.inputs.map((h) => {
    if (h.from === null) {
      return { fromNodeId: null, payload: h.output };
    }
    const edge = inboundEdges.find((e) => e.from === h.from);
    return {
      fromNodeId: h.from,
      payload: edge ? edge.payload : h.output,
    };
  });

  const outboundEdges = plan.edges.filter((e) => e.from === node.id);
  const downstream: HandoffContract['downstream'] = outboundEdges.map((e) => ({
    toNodeId: e.to,
    payload: e.payload,
  }));

  return {
    selfNodeId: node.id,
    upstream,
    downstream,
    declaredOutputs: node.outputs,
  };
}

function moduleFilePath(nodeId: string): string {
  return 'src/modules/' + nodeId + '/index.ts';
}

function moduleFilePurpose(node: OrchestrationNode): string {
  const outputs =
    node.outputs.length === 0
      ? '(no outputs)'
      : 'outputs: { ' + node.outputs.join(', ') + ' }';
  return (
    "Module for node '" +
    node.id +
    "' (role: " +
    node.role +
    '). Exports `run(input)` returning ' +
    outputs +
    '. ' +
    node.task
  );
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
