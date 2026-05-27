// Aurexis Forge — Phase 2 (Systems) per-run scheduler.
//
// `runSystemOnce` is the system-kind branch of the shared Phase 1
// `runOnce`. It mirrors Phase 1's per-run lifecycle (governance gate
// → runs-row insertion → execute → ledger → finishRunRow → audit)
// using the SAME shared helpers from lib/engine/runtime/persistence.ts
// so a system run lives in the SAME runs table, increments the SAME
// auto-pause counter, and is governed by the SAME budget + kill switch
// posture as an agent run. The only system-specific bits are the
// context loader (parses SystemSpec + OrchestrationPlan) and the
// executor (runs the orchestrator in LIVE mode).
//
// The shared cost ceiling — non-negotiable #3 of Phase 2 — applies
// naturally here: one orchestration run = ONE governed unit. The
// pre-run guard checks projected cost from max_run_ms; the kill
// switch fires mid-run via the executor's watcher; the post-run
// ledger records the run's total compute_ms as one event.

import type { ForgeSupabase } from '@/lib/supabase';
import type {
  AgentRunTrigger,
  AgentRuntime,
  BuildFile,
  Plan,
  Spec,
} from '@/lib/types';
import { assertAllowed, GovernanceError } from '@/lib/engine/governance/guard';
import { recordCost } from '@/lib/engine/governance/ledger';
import { projectedComputeCostUsd } from '@/lib/engine/governance/pricing';
import { peekKeySource, NeedsKeyError } from '@/lib/engine/keys';
import {
  audit,
  decryptRuntimeEnv,
  finishRunRow,
  insertRunningRunRow,
} from '@/lib/engine/runtime/persistence';
import { SystemSpecSchema, type SystemSpec } from '../spec';
import {
  OrchestrationPlanSchema,
  type OrchestrationPlan,
} from '../planner/schema';
import {
  executeSystemRun,
  type SystemExecutorResult,
} from './executor';

// One end-to-end system orchestration. Called by Phase 1's `runOnce`
// when runtime.kind === 'system'. Returns void; all outcomes are
// persisted to runs + agent_runtimes + audit_log.
export async function runSystemOnce(
  supabase: ForgeSupabase,
  runtime: AgentRuntime,
  trigger: AgentRunTrigger,
): Promise<void> {
  // --- 1. Reload + re-validate the system spec/plan/files chain --------
  // A system runtime activated weeks ago might reference a stale plan
  // (the planner could have evolved). Defensive reload + schema
  // re-validation surface that cleanly before we burn sandbox time.
  const ctx = await loadSystemRunContext(supabase, runtime);
  if ('error' in ctx) {
    await audit(supabase, {
      projectId: runtime.project_id,
      action: 'system.run_failed',
      actor: 'engine.system.runtime',
      detail: { runtime_id: runtime.id, error: ctx.error },
    });
    return;
  }

  // --- 2. Per-run governance gate (the SHARED ceiling) ----------------
  // One run = one governed unit. The guard checks budget + kill switch
  // against the WHOLE run, not per agent. Projected cost comes from
  // max_run_ms so a 60s system run is budgeted exactly the same as a
  // 60s agent run.
  const { data: projectRow } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', runtime.project_id)
    .single();
  const userId = (projectRow as { user_id: string | null } | null)?.user_id ?? null;

  const peek = await peekKeySource(userId, 'e2b', supabase);
  const guardKeySource = peek.source === 'byok' ? 'byok' : 'platform';

  try {
    await assertAllowed(
      {
        user_id: userId,
        project_id: runtime.project_id,
        projectedCostUsd: projectedComputeCostUsd('runtime', runtime.max_run_ms),
        keySource: guardKeySource,
      },
      supabase,
    );
  } catch (err) {
    if (err instanceof GovernanceError) {
      await handleSystemBudgetBlock(supabase, runtime, err);
      return;
    }
    throw err;
  }

  // --- 3. Insert the runs-row + audit run_started ---------------------
  const runRow = await insertRunningRunRow(supabase, runtime.id, trigger);
  await audit(supabase, {
    projectId: runtime.project_id,
    action: 'system.run_started',
    actor: 'engine.system.runtime',
    detail: {
      runtime_id: runtime.id,
      run_id: runRow.id,
      trigger,
      nodes: ctx.plan.nodes.length,
    },
  });

  // --- 4. Decrypt env (in-memory only; dropped after exec) ------------
  let env: Record<string, string> = {};
  try {
    env = decryptRuntimeEnv(runtime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'decrypt_failed';
    await finishRunRow(supabase, {
      runtime,
      runId: runRow.id,
      result: {
        success: false,
        output: null,
        logs: [],
        error: 'env decrypt failed: ' + msg,
        duration_ms: 0,
        provider: 'unknown',
        // Nothing actually executed — attribute the (zero) cost to
        // platform rather than fabricate a BYOK event.
        key_source: 'platform',
      },
      scheduleNextTick: trigger === 'tick',
    });
    await audit(supabase, {
      projectId: runtime.project_id,
      action: 'system.run_failed',
      actor: 'engine.system.runtime',
      detail: { runtime_id: runtime.id, run_id: runRow.id, error: msg },
    });
    return;
  }

  // --- 5. Execute the orchestrator in LIVE mode -----------------------
  let result: SystemExecutorResult;
  try {
    result = await executeSystemRun({
      spec: ctx.spec,
      plan: ctx.plan,
      files: ctx.files,
      env,
      maxRunMs: runtime.max_run_ms,
      user_id: userId,
      project_id: runtime.project_id,
      // Pass the supabase client through so the executor's
      // kill-switch watcher polls the same DB the rest of the
      // platform sees.
      supabase,
    });
  } catch (err) {
    if (err instanceof NeedsKeyError) {
      // Translate to a normal failed-run shape; the route layer can
      // map this to a friendly 412 when triggered by /run-now.
      const msg = 'needs ' + err.provider + ' key';
      await finishRunRow(supabase, {
        runtime,
        runId: runRow.id,
        result: {
          success: false,
          output: null,
          logs: [],
          error: msg,
          duration_ms: 0,
          provider: 'unknown',
          key_source: 'platform',
        },
        scheduleNextTick: trigger === 'tick',
      });
      await audit(supabase, {
        projectId: runtime.project_id,
        action: 'system.run_failed',
        actor: 'engine.system.runtime',
        detail: {
          runtime_id: runtime.id,
          run_id: runRow.id,
          error: msg,
          reason: 'needs_key',
        },
      });
      throw err; // re-throw so run-now can render the 412 gate
    }
    throw err;
  }
  // Drop the decrypted env from memory ASAP.
  env = {};

  // --- 6. Ledger — one event per run (SHARED ceiling) -----------------
  // The whole orchestration is ONE governed unit. recordCost swallows
  // its own errors; a broken ledger will be caught by the next guard.
  void recordCost(
    {
      user_id: userId,
      project_id: runtime.project_id,
      kind: 'runtime',
      compute_ms: result.duration_ms,
      key_source: result.key_source,
      ref: 'system.runtime.' + trigger + '.' + runRow.id,
    },
    supabase,
  );

  // --- 7. Finish the runs row + audit the outcome ---------------------
  // Translate the system executor's result into the shape the SHARED
  // finishRunRow helper expects. The shared helper handles the
  // run_count / fail_count / consecutive_fails math + the 3-strike
  // auto-pause threshold identically for both kinds.
  const { autoPaused } = await finishRunRow(supabase, {
    runtime,
    runId: runRow.id,
    result: {
      success: result.success,
      output: result.output as unknown,
      logs: result.logs,
      error: result.error,
      duration_ms: result.duration_ms,
      provider: result.provider,
      key_source: result.key_source,
    },
    scheduleNextTick: trigger === 'tick',
  });

  await audit(supabase, {
    projectId: runtime.project_id,
    action: result.success ? 'system.run_succeeded' : 'system.run_failed',
    actor: 'engine.system.runtime',
    detail: {
      runtime_id: runtime.id,
      run_id: runRow.id,
      duration_ms: result.duration_ms,
      provider: result.provider,
      steps_completed: result.steps_completed,
      ...(result.success
        ? {
            final_node: result.output?.final_node ?? null,
            output_keys: result.output?.output_keys ?? [],
          }
        : {
            error: result.error,
            handoff_failure_node: result.handoff_failure?.node ?? null,
            killed_by_kill_switch: result.killed_by_kill_switch,
          }),
    },
  });

  if (autoPaused) {
    await audit(supabase, {
      projectId: runtime.project_id,
      action: 'system.runtime_auto_paused',
      actor: 'engine.system.runtime',
      detail: {
        runtime_id: runtime.id,
        consecutive_fails: runtime.consecutive_fails + 1,
      },
    });
  }
}

// --- Budget block handler --------------------------------------------------

// Mirror of Phase 1's `handleBudgetBlock`. When a system runtime hits
// its budget cap OR a scoped kill switch, we auto-pause it to
// 'errored' so the scheduler stops picking it up.
async function handleSystemBudgetBlock(
  supabase: ForgeSupabase,
  runtime: AgentRuntime,
  err: GovernanceError,
): Promise<void> {
  const isKilled = err.reason === 'killed';
  const isProjectOrUserKill = isKilled && err.detail.scope !== 'global';

  await supabase
    .from('agent_runtimes')
    .update({ status: 'errored', next_run_at: null })
    .eq('id', runtime.id);

  await audit(supabase, {
    projectId: runtime.project_id,
    action:
      err.reason === 'budget'
        ? 'system.runtime_budget_paused'
        : isProjectOrUserKill
          ? 'system.action_blocked_killswitch'
          : 'system.action_blocked_budget',
    actor: 'engine.governance',
    detail: {
      runtime_id: runtime.id,
      reason: err.reason,
      ...err.detail,
    },
  });
}

// --- Context loader (lighter than persistence.loadSystemRuntimeContext) ----

interface SystemRunContext {
  spec: SystemSpec;
  plan: OrchestrationPlan;
  files: BuildFile[];
}

async function loadSystemRunContext(
  supabase: ForgeSupabase,
  runtime: AgentRuntime,
): Promise<SystemRunContext | { error: string }> {
  const { data: builds } = await supabase
    .from('builds')
    .select('*')
    .eq('id', runtime.build_id)
    .limit(1);
  const build = builds?.[0];
  if (!build) return { error: 'build not found' };
  if (!build.spec_id || !build.plan_id) {
    return { error: 'build is missing spec_id or plan_id' };
  }

  const { data: specRow } = await supabase
    .from('specs')
    .select('*')
    .eq('id', build.spec_id)
    .single();
  const spec = (specRow as Spec | null) ?? null;
  if (!spec) return { error: 'spec missing' };
  if (spec.kind !== 'system') {
    return { error: 'spec kind is not system' };
  }
  const parsedSpec = SystemSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return { error: 'spec no longer matches SystemSpec schema' };
  }

  const { data: planRow } = await supabase
    .from('plans')
    .select('*')
    .eq('id', build.plan_id)
    .single();
  const plan = (planRow as Plan | null) ?? null;
  if (!plan) return { error: 'plan missing' };
  if (plan.kind !== 'system') {
    return { error: 'plan kind is not system' };
  }
  const parsedPlan = OrchestrationPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return { error: 'plan no longer matches OrchestrationPlan schema' };
  }

  const { data: files } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  const buildFiles = (files ?? []) as BuildFile[];
  if (buildFiles.length === 0) return { error: 'no build files' };

  return {
    spec: parsedSpec.data,
    plan: parsedPlan.data,
    files: buildFiles,
  };
}
