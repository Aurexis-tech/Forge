// Aurexis Forge — Phase 2 (Systems) sandbox smoke-driver synthesis.
//
// The system runner writes ONE extra file into the sandbox —
// `forge_system_smoke.mjs` — that imports the generated orchestrator,
// builds a synthetic external input from the plan's `from===null`
// handoffs, calls `orchestrate(externalInput)` ONCE, and prints a
// structured result line (`[smoke] orchestrate_passed` / `_failed`).
//
// Tools imported by per-node modules self-mock when
// `FORGE_MOCK_TOOLS=1` — identical posture to the Phase 1 smoke test.
// No real network, no real secrets.
//
// The orchestrator's two non-negotiables are exercised end-to-end:
//   - MAX-STEPS ceiling: a runaway orchestrator throws before steps
//     can exceed `SystemSpec.max_steps` — the smoke fails fast.
//   - HANDOFF VALIDATION: any module that drops a declared output is
//     caught by the orchestrator's fail-closed check, surfaces as an
//     `OrchestratorError`, and the smoke captures the failing node so
//     the runner can attempt a bounded self-heal.

import type { OrchestrationPlan } from '../planner/schema';

export interface SystemSmokePlan {
  // Contents of forge_system_smoke.mjs to write into the sandbox.
  driverContent: string;
  // The shell command the runner executes for the smoke phase.
  command: string;
  // Hard wall-clock cap.
  timeoutMs: number;
  // The synthetic external input (also embedded in the driver) — kept
  // here so the runner can record it in the audit log without re-
  // parsing the driver.
  externalInput: Record<string, string>;
}

const SMOKE_TIMEOUT_MS = 30_000;

// Build a stub external input from the plan: every `from === null`
// handoff becomes a string placeholder keyed by `output`. The keys are
// the only thing the orchestrator looks up; the values are opaque so
// modules can read them as `unknown` and pass them through.
export function buildExternalInput(plan: OrchestrationPlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of plan.nodes) {
    for (const h of node.inputs) {
      if (h.from === null) {
        out[h.output] = '<smoke:' + h.output + '>';
      }
    }
  }
  return out;
}

export function planSystemSmokeTest(args: {
  plan: OrchestrationPlan;
}): SystemSmokePlan {
  const externalInput = buildExternalInput(args.plan);
  // expected_steps matches plan.nodes.length — the orchestrator's
  // walker pushes one step per node invocation in execution_order.
  const expectedSteps = args.plan.nodes.length;
  // ROUTER (selection): a router run executes the router + exactly ONE
  // branch, SKIPPING the rest — so the exact step-count / final-node
  // assertions don't hold. Relax to a range (1..nodes) + a non-empty
  // final node. The MAX_STEPS ceiling + per-node handoff validation on the
  // executed path still apply. LIMITATION: only the branch the generated
  // router happens to select is runtime-smoked; every branch is STATICALLY
  // validated at plan time + the selection rule is unit-tested.
  const routerMode = Boolean(args.plan.branch);
  return {
    driverContent: buildSystemSmokeDriver({
      externalInput,
      expectedSteps,
      finalNode:
        args.plan.execution_order[args.plan.execution_order.length - 1] ?? '',
      routerMode,
    }),
    command: 'npx tsx --tsconfig tsconfig.json forge_system_smoke.mjs',
    timeoutMs: SMOKE_TIMEOUT_MS,
    externalInput,
  };
}

function buildSystemSmokeDriver(args: {
  externalInput: Record<string, string>;
  expectedSteps: number;
  finalNode: string;
  routerMode: boolean;
}): string {
  // Embedded constants — JSON-stringified once so the driver doesn't
  // re-encode them every call. The orchestrator is always at the same
  // path in a system build (deterministic codegen).
  const externalInputJson = JSON.stringify(args.externalInput);
  // Router runs skip non-selected branches, so the executed node count is a
  // RANGE (1..expected) and the final node is the selected branch's
  // terminal — not the last node in execution_order. Emit relaxed checks.
  const stepCheck = args.routerMode
    ? [
        "    if (typeof result.steps !== 'number' || result.steps < 1 || result.steps > EXPECTED_STEPS) {",
        "      log('step_count_out_of_range', { max: EXPECTED_STEPS, actual: result.steps });",
        "      process.exit(6);",
        "      return;",
        "    }",
        "    if (typeof result.final_node !== 'string' || result.final_node.length === 0) {",
        "      log('final_node_missing', { actual: result.final_node });",
        "      process.exit(7);",
        "      return;",
        "    }",
      ]
    : [
        "    if (typeof result.steps !== 'number' || result.steps !== EXPECTED_STEPS) {",
        "      log('step_count_mismatch', { expected: EXPECTED_STEPS, actual: result.steps });",
        "      process.exit(6);",
        "      return;",
        "    }",
        "    if (typeof result.final_node !== 'string' || result.final_node !== EXPECTED_FINAL_NODE) {",
        "      log('final_node_mismatch', { expected: EXPECTED_FINAL_NODE, actual: result.final_node });",
        "      process.exit(7);",
        "      return;",
        "    }",
      ];
  return [
    "// Generated by Aurexis Forge — Phase 2 system sandbox smoke driver.",
    "// Loads the generated orchestrator and runs ONE orchestration with a",
    "// synthetic external input. Tools self-mock under FORGE_MOCK_TOOLS=1.",
    "// Prints a structured [smoke] line on every terminal state — the",
    "// runner parses these to decide pass / fail / self-heal.",
    "",
    "const EXTERNAL_INPUT = " + externalInputJson + ";",
    "const EXPECTED_STEPS = " + String(args.expectedSteps) + ";",
    "const EXPECTED_FINAL_NODE = " + JSON.stringify(args.finalNode) + ";",
    "",
    "function log(tag, payload) {",
    "  const line = '[smoke] ' + tag + (payload ? ' ' + JSON.stringify(payload) : '');",
    "  console.log(line);",
    "}",
    "",
    "async function main() {",
    "  let orchestratorMod;",
    "  try {",
    "    orchestratorMod = await import('./src/orchestrator.ts');",
    "  } catch (err) {",
    "    log('orchestrator_load_failed', {",
    "      error: err && err.message ? err.message : String(err),",
    "    });",
    "    process.exit(2);",
    "    return;",
    "  }",
    "",
    "  if (typeof orchestratorMod.orchestrate !== 'function') {",
    "    log('orchestrator_missing_export', { exports: Object.keys(orchestratorMod) });",
    "    process.exit(3);",
    "    return;",
    "  }",
    "",
    "  try {",
    "    const result = await orchestratorMod.orchestrate(EXTERNAL_INPUT);",
    "    // Sanity-check the result shape — guards against a runaway",
    "    // orchestrator silently returning before all nodes ran.",
    "    if (!result || typeof result !== 'object') {",
    "      log('bad_result_shape', { got: typeof result });",
    "      process.exit(5);",
    "      return;",
    "    }",
    ...stepCheck,
    "    log('orchestrate_passed', {",
    "      steps: result.steps,",
    "      final_node: result.final_node,",
    "    });",
    "    process.exit(0);",
    "  } catch (err) {",
    "    if (err && err.name === 'OrchestratorError') {",
    "      log('orchestrate_failed', {",
    "        node: err.node === undefined ? null : err.node,",
    "        message: err.message,",
    "      });",
    "      process.exit(1);",
    "      return;",
    "    }",
    "    log('orchestrator_threw', {",
    "      error: err && err.message ? err.message : String(err),",
    "      name: err && err.name ? err.name : 'unknown',",
    "    });",
    "    process.exit(4);",
    "  }",
    "}",
    "",
    "main().catch((err) => {",
    "  log('driver_threw', { error: err && err.message ? err.message : String(err) });",
    "  process.exit(99);",
    "});",
    "",
  ].join('\n');
}

// Parse the failing-node id from the smoke output. The driver emits a
// JSON-trailing `[smoke] orchestrate_failed {"node":"...","message":"..."}`
// line; we read it back so the runner can decide whether to self-heal.
// Returns null when no parseable failed line is found (covers
// orchestrator_threw / driver_threw paths — those can't be self-healed
// because we don't know which module is at fault).
export function parseFailingNode(combined: string): string | null {
  // Walk lines bottom-up — the latest [smoke] line is the one we care
  // about (a self-heal retry will append a new line).
  const lines = combined.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const marker = '[smoke] orchestrate_failed ';
    const at = line.indexOf(marker);
    if (at < 0) continue;
    const jsonStr = line.slice(at + marker.length).trim();
    try {
      const parsed = JSON.parse(jsonStr) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'node' in parsed &&
        typeof (parsed as { node?: unknown }).node === 'string'
      ) {
        return (parsed as { node: string }).node;
      }
    } catch {
      // Malformed JSON — fall through, keep searching backwards.
    }
  }
  return null;
}
