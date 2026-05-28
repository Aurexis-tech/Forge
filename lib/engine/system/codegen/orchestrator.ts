// Aurexis Forge — Phase 2 (Systems) deterministic orchestrator generator.
//
// Produces the source code for the system's `src/orchestrator.ts` file
// from a confirmed SystemSpec + an approved OrchestrationPlan. The
// orchestrator:
//
//   - imports each node's module (`src/modules/<node_id>/index.js`) and
//     calls its `run(input)` function
//   - walks the plan's `execution_order` and assembles each node's input
//     by looking up upstream nodes' outputs per the plan's handoff
//     contract (`node.inputs[].from` + `node.inputs[].output`)
//   - bakes in the two Phase 2 non-negotiables:
//       (a) a HARD MAX-STEPS ceiling derived from
//           `SystemSpec.max_steps` so a run can't loop forever
//       (b) HANDOFF VALIDATION — each node's returned object is checked
//           against `node.outputs` before it can be referenced by a
//           downstream node, and each downstream node's input lookup
//           fails closed if an expected key is missing
//
// This module is DATA ONLY — it never executes the orchestrator it
// emits. Codegen-time, the generated source goes through the existing
// esbuild static check (`staticCheckFile`); runtime execution would
// only happen in a future sandbox layer (Phase 2-4), which this prompt
// does NOT add.

import type { SystemSpec } from '../spec';
import type {
  OrchestrationPlan,
  OrchestrationNode,
} from '../planner/schema';

export interface OrchestratorSource {
  readonly path: string;
  readonly content: string;
}

// Generate the orchestrator TypeScript source. Uses ES module syntax +
// `.js` local-import extensions to match the rest of the agent scaffold
// (which the Phase 1 codegen prompt mandates).
export function generateOrchestratorSource(
  spec: SystemSpec,
  plan: OrchestrationPlan,
): OrchestratorSource {
  const lines: string[] = [];

  lines.push('// Aurexis Forge — Phase 2 system orchestrator (generated).');
  lines.push('//');
  lines.push('// Walks the approved OrchestrationPlan in topological order, calls each');
  lines.push("// sub-agent module's exported run() with the upstream outputs it depends on,");
  lines.push("// and validates every handoff against the plan's declared output contract.");
  lines.push('// Two non-negotiables enforced at runtime:');
  lines.push('//   - MAX_STEPS hard ceiling per invocation');
  lines.push('//   - HANDOFF validation per edge');
  lines.push('//');
  lines.push('// This file is generated. Do not edit by hand.');
  lines.push('');

  // Per-node module imports. Each module exports a default async
  // function `run(input)`. We use namespace imports so the orchestrator
  // can route by node id without leaking module-specific shapes here.
  for (const node of plan.nodes) {
    lines.push(
      'import { run as ' + nodeRunBinding(node.id) +
      " } from './modules/" + node.id + "/index.js';",
    );
  }
  lines.push('');

  // Constants pulled directly from the SystemSpec — the planner already
  // enforces max_steps fits in the spec's cap; embedding the literal
  // here makes the ceiling visible to every reader of the generated
  // file.
  lines.push('// Hard MAX-STEPS ceiling lifted verbatim from SystemSpec.max_steps.');
  lines.push('// A run that crosses this throws — no recovery path.');
  lines.push('const MAX_STEPS = ' + String(spec.max_steps) + ';');
  lines.push('');

  // The plan's handoff contract as a typed constant — the runtime
  // walker consults this to assemble inputs + validate outputs. Stored
  // as a Record so the orchestrator can do exact-key lookups.
  lines.push('// Handoff contract — every node\'s declared inputs/outputs.');
  lines.push('// from === null means "the system\'s external input payload".');
  lines.push('interface Handoff {');
  lines.push('  from: string | null;');
  lines.push('  output: string;');
  lines.push('}');
  lines.push('interface NodeContract {');
  lines.push('  id: string;');
  lines.push('  role: string;');
  lines.push('  inputs: Handoff[];');
  lines.push('  outputs: string[];');
  lines.push('}');
  lines.push('');

  // Inline the contract as a const literal. We JSON-stringify with
  // indentation so the generated file stays readable; the LLM never
  // touches this file so there's no prompt-budget pressure to compress.
  const contract = plan.nodes.map((n: OrchestrationNode) => ({
    id: n.id,
    role: n.role,
    inputs: n.inputs.map((h) => ({ from: h.from, output: h.output })),
    outputs: n.outputs,
  }));
  lines.push(
    'const NODE_CONTRACTS: NodeContract[] = ' +
      JSON.stringify(contract, null, 2) +
      ';',
  );
  lines.push('');

  // execution_order is a permutation of node ids; literal export so a
  // human or sandbox can sanity-check the walk order at a glance.
  lines.push(
    'const EXECUTION_ORDER: string[] = ' +
      JSON.stringify(plan.execution_order) +
      ';',
  );
  lines.push('');

  // ROUTER (selection): when the plan carries branch metadata, inline it so
  // the walker can run EXACTLY ONE branch — the subgraph keyed by the
  // router's decision — and SKIP the rest. Absent for every other pattern
  // (the walk below is then byte-identical to the pre-router orchestrator).
  if (plan.branch) {
    lines.push('// Branch metadata (router). After the router node runs, the walker');
    lines.push('// reads its `branch` decision and skips every non-selected branch.');
    lines.push('interface BranchDef { key: string; nodeIds: string[]; }');
    lines.push('interface BranchMeta { routerId: string; branches: BranchDef[]; }');
    lines.push(
      'const BRANCH_META: BranchMeta = ' +
        JSON.stringify(plan.branch, null, 2) +
        ';',
    );
    lines.push('');
  }

  // Dispatch map: node id → module's run function. Built from the
  // imports above. Typed to `unknown` for both directions so the
  // orchestrator stays honest about not knowing each module's shape
  // — the handoff validator is the only contract enforcer.
  lines.push('type ModuleRun = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;');
  lines.push('const MODULES: Record<string, ModuleRun> = {');
  for (const node of plan.nodes) {
    lines.push(
      "  " + JSON.stringify(node.id) + ': ' + nodeRunBinding(node.id) +
      ' as unknown as ModuleRun,',
    );
  }
  lines.push('};');
  lines.push('');

  // The walker itself. Pure orchestration logic; no I/O of its own.
  // Inputs assembly fails closed when a declared upstream output is
  // missing (HANDOFF VALIDATION on the consume side). After each
  // node returns, we validate the returned object carries every
  // declared output (HANDOFF VALIDATION on the produce side). Step
  // count caps at MAX_STEPS — one increment per node invocation.
  lines.push('export class OrchestratorError extends Error {');
  lines.push('  readonly node: string | null;');
  lines.push('  constructor(message: string, node: string | null = null) {');
  lines.push('    super(message);');
  lines.push("    this.name = 'OrchestratorError';");
  lines.push('    this.node = node;');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('export interface OrchestrateResult {');
  lines.push('  outputs: Record<string, Record<string, unknown>>;');
  lines.push('  steps: number;');
  lines.push('  final_node: string;');
  lines.push('}');
  lines.push('');
  lines.push('export async function orchestrate(');
  lines.push('  external: Record<string, unknown>,');
  lines.push('): Promise<OrchestrateResult> {');
  lines.push('  const outputsByNode: Record<string, Record<string, unknown>> = {};');
  lines.push('  let steps = 0;');
  lines.push('  let finalNode = "";');
  if (plan.branch) {
    lines.push('  // Nodes whose branch was NOT selected by the router; skipped below.');
    lines.push('  const skip = new Set<string>();');
  }
  lines.push('');
  lines.push('  for (const nodeId of EXECUTION_ORDER) {');
  if (plan.branch) {
    lines.push('    // ROUTER conditional skip: a non-selected branch node does not');
    lines.push('    // execute, is not validated, and does not count toward steps.');
    lines.push('    if (skip.has(nodeId)) {');
    lines.push('      continue;');
    lines.push('    }');
  }
  lines.push('    if (steps >= MAX_STEPS) {');
  lines.push('      throw new OrchestratorError(');
  lines.push("        'max-steps ceiling of ' + String(MAX_STEPS) + ' exceeded — orchestrator aborted',");
  lines.push('        nodeId,');
  lines.push('      );');
  lines.push('    }');
  lines.push('');
  lines.push('    const contract = NODE_CONTRACTS.find((c) => c.id === nodeId);');
  lines.push('    if (!contract) {');
  lines.push("      throw new OrchestratorError('execution_order references unknown node ' + nodeId, nodeId);");
  lines.push('    }');
  lines.push('');
  lines.push('    // Assemble input from declared handoffs. Each handoff must');
  lines.push('    // resolve to a present key on the producer side.');
  lines.push('    const input: Record<string, unknown> = {};');
  lines.push('    for (const h of contract.inputs) {');
  lines.push('      if (h.from === null) {');
  lines.push('        if (!(h.output in external)) {');
  lines.push('          throw new OrchestratorError(');
  lines.push("            'handoff failed: external input missing key ' + JSON.stringify(h.output),");
  lines.push('            nodeId,');
  lines.push('          );');
  lines.push('        }');
  lines.push('        input[h.output] = external[h.output];');
  lines.push('        continue;');
  lines.push('      }');
  lines.push('      const upstream = outputsByNode[h.from];');
  lines.push('      if (!upstream) {');
  lines.push('        throw new OrchestratorError(');
  lines.push("          'handoff failed: upstream node ' + h.from + ' has not produced outputs yet',");
  lines.push('          nodeId,');
  lines.push('        );');
  lines.push('      }');
  lines.push('      if (!(h.output in upstream)) {');
  lines.push('        throw new OrchestratorError(');
  lines.push("          'handoff failed: node ' + h.from + ' did not produce expected output ' + JSON.stringify(h.output),");
  lines.push('          nodeId,');
  lines.push('        );');
  lines.push('      }');
  lines.push('      input[h.output] = upstream[h.output];');
  lines.push('    }');
  lines.push('');
  lines.push('    const run = MODULES[nodeId];');
  lines.push('    if (!run) {');
  lines.push("      throw new OrchestratorError('no module registered for node ' + nodeId, nodeId);");
  lines.push('    }');
  lines.push('    const out = await run(input);');
  lines.push('    if (out === null || typeof out !== "object" || Array.isArray(out)) {');
  lines.push('      throw new OrchestratorError(');
  lines.push("        'node ' + nodeId + ' returned a non-object — modules must return Record<string, unknown>',");
  lines.push('        nodeId,');
  lines.push('      );');
  lines.push('    }');
  lines.push('');
  lines.push('    // Validate every declared output is present on the returned');
  lines.push('    // object. Fails closed — a node that drops a contracted');
  lines.push('    // output is a build-time correctness bug.');
  lines.push('    for (const key of contract.outputs) {');
  lines.push('      if (!(key in out)) {');
  lines.push('        throw new OrchestratorError(');
  lines.push("          'handoff validation failed: node ' + nodeId + ' did not return expected output ' + JSON.stringify(key),");
  lines.push('          nodeId,');
  lines.push('        );');
  lines.push('      }');
  lines.push('    }');
  lines.push('');
  lines.push('    outputsByNode[nodeId] = out;');
  lines.push('    finalNode = nodeId;');
  lines.push('    steps++;');
  if (plan.branch) {
    lines.push('');
    lines.push('    // ROUTER decision: after the router runs, read its `branch` signal');
    lines.push('    // and mark every non-selected branch node for skipping. A decision');
    lines.push('    // matching no branch key fails closed (router_no_branch_match) — never');
    lines.push('    // a silent fall-through.');
    lines.push('    if (nodeId === BRANCH_META.routerId) {');
    lines.push('      const decision = out.branch;');
    lines.push('      const selected = BRANCH_META.branches.find((b) => b.key === decision);');
    lines.push('      if (!selected) {');
    lines.push('        throw new OrchestratorError(');
    lines.push("          'router_no_branch_match: router decision ' + JSON.stringify(decision) + ' matched no branch key',");
    lines.push('          nodeId,');
    lines.push('        );');
    lines.push('      }');
    lines.push('      const keep = new Set(selected.nodeIds);');
    lines.push('      for (const b of BRANCH_META.branches) {');
    lines.push('        if (b.key === selected.key) continue;');
    lines.push('        for (const id of b.nodeIds) {');
    lines.push('          if (!keep.has(id)) skip.add(id);');
    lines.push('        }');
    lines.push('      }');
    lines.push('    }');
  }
  lines.push('  }');
  lines.push('');
  lines.push('  return { outputs: outputsByNode, steps, final_node: finalNode };');
  lines.push('}');
  lines.push('');

  return {
    path: 'src/orchestrator.ts',
    content: lines.join('\n') + '\n',
  };
}

// Map a node id to a local TypeScript binding name. The id is already
// lower_snake_case (schema-enforced), so it's a valid TS identifier on
// its own — we prefix to avoid collisions with any of the orchestrator's
// own names (`MODULES`, `run`, etc).
function nodeRunBinding(nodeId: string): string {
  return 'mod_' + nodeId + '_run';
}

// A tiny "boot" entrypoint that wires the orchestrator to a generic
// stdin/argv handoff. The system codegen emits this once at
// `src/index.ts` so a future runtime layer has a clear seam to call
// into. It's intentionally minimal — heavy lifting lives in the
// orchestrator itself.
export function generateSystemEntrypointSource(): OrchestratorSource {
  const lines: string[] = [];
  lines.push('// Aurexis Forge — Phase 2 system entrypoint (generated).');
  lines.push('//');
  lines.push("// Reads a JSON payload from argv[2] (or '{}' when absent) and runs the");
  lines.push('// orchestrator once. The runtime layer (future) calls this with the');
  lines.push('// trigger payload; for now this file exists so the static check can');
  lines.push('// confirm the wiring compiles end-to-end.');
  lines.push('');
  lines.push("import { orchestrate, OrchestratorError } from './orchestrator.js';");
  lines.push('');
  lines.push('async function main(): Promise<void> {');
  lines.push("  const raw = process.argv[2] ?? '{}';");
  lines.push('  let payload: Record<string, unknown>;');
  lines.push('  try {');
  lines.push('    const parsed = JSON.parse(raw) as unknown;');
  lines.push("    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {");
  lines.push("      throw new Error('payload must be a JSON object');");
  lines.push('    }');
  lines.push('    payload = parsed as Record<string, unknown>;');
  lines.push('  } catch (err) {');
  lines.push('    const message = err instanceof Error ? err.message : String(err);');
  lines.push("    process.stderr.write('invalid payload: ' + message + '\\n');");
  lines.push('    process.exit(2);');
  lines.push('    return;');
  lines.push('  }');
  lines.push('');
  lines.push('  try {');
  lines.push('    const result = await orchestrate(payload);');
  lines.push('    process.stdout.write(JSON.stringify(result) + "\\n");');
  lines.push('  } catch (err) {');
  lines.push('    if (err instanceof OrchestratorError) {');
  lines.push("      process.stderr.write('orchestrator failed at node ' + String(err.node) + ': ' + err.message + '\\n');");
  lines.push('      process.exit(1);');
  lines.push('      return;');
  lines.push('    }');
  lines.push('    throw err;');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push("void main();");
  lines.push('');
  return {
    path: 'src/index.ts',
    content: lines.join('\n') + '\n',
  };
}
