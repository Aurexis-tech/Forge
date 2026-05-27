// The scheduler picks active runtimes whose next_run_at has elapsed and
// executes each in its own isolated sandbox. Strict global + per-runtime
// concurrency caps prevent a misbehaving cron from snowballing.

import { getServerSupabase, type ForgeSupabase } from '@/lib/supabase';
import type { AgentRunTrigger, AgentRuntime, BuildFile, Plan, Spec } from '@/lib/types';
import { assertAllowed, GovernanceError } from '../governance/guard';
import { activeKillSwitch } from '../governance/killswitch';
import { recordCost } from '../governance/ledger';
import { projectedComputeCostUsd } from '../governance/pricing';
import { peekKeySource } from '../keys';
import { BuildPlanSchema, type BuildPlan } from '../planner/schema';
import { AgentSpecSchema, type AgentSpec } from '../spec/schema';
import { executeAgentRun } from './executor';
import {
  audit,
  decryptRuntimeEnv,
  finishRunRow,
  insertRunningRunRow,
} from './persistence';

const GLOBAL_CONCURRENCY_CAP = 3;
const MAX_RUNTIMES_PER_TICK = 5;

export interface TickSummary {
  picked: number;
  executed: number;
  skipped_concurrency: number;
  skipped_per_runtime: number;
  global_running_before: number;
}

export async function tickRuntimes(): Promise<TickSummary> {
  const supabase = getServerSupabase();
  const nowIso = new Date().toISOString();

  // Global kill switch trumps everything — never even look at runtimes.
  const globalKill = await activeKillSwitch({}, supabase);
  if (globalKill && globalKill.scope === 'global') {
    return {
      picked: 0,
      executed: 0,
      skipped_concurrency: 0,
      skipped_per_runtime: 0,
      global_running_before: 0,
    };
  }

  // Global concurrency: cap by counting currently 'running' rows. If we're
  // already at the cap, do nothing and bail.
  const { count: globalRunning } = await supabase
    .from('runs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'running');
  const currentlyRunning = globalRunning ?? 0;
  const slots = Math.max(0, GLOBAL_CONCURRENCY_CAP - currentlyRunning);
  if (slots === 0) {
    return {
      picked: 0,
      executed: 0,
      skipped_concurrency: 0,
      skipped_per_runtime: 0,
      global_running_before: currentlyRunning,
    };
  }

  // Pick the next due runtimes — oldest next_run_at first so nothing starves.
  const { data: due } = await supabase
    .from('agent_runtimes')
    .select('*')
    .eq('status', 'active')
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(Math.min(MAX_RUNTIMES_PER_TICK, slots));

  const candidates = (due ?? []) as AgentRuntime[];
  let executed = 0;
  let skippedPerRuntime = 0;
  let skippedConcurrency = 0;

  for (const runtime of candidates) {
    if (executed >= slots) {
      skippedConcurrency++;
      continue;
    }
    // Per-runtime concurrency: don't double-fire the same agent.
    const { data: existing } = await supabase
      .from('runs')
      .select('id')
      .eq('runtime_id', runtime.id)
      .eq('status', 'running')
      .limit(1);
    if (existing && existing.length > 0) {
      skippedPerRuntime++;
      continue;
    }

    try {
      await runOnce(supabase, runtime, 'tick');
      executed++;
    } catch (err) {
      // Catastrophic failures inside the run loop must not abort the tick.
      const msg = err instanceof Error ? err.message : String(err);
      await audit(supabase, {
        projectId: runtime.project_id,
        action: 'run.failed',
        actor: 'engine.runtime',
        detail: { runtime_id: runtime.id, error: msg, scope: 'scheduler_catch' },
      });
    }
  }

  return {
    picked: candidates.length,
    executed,
    skipped_concurrency: skippedConcurrency,
    skipped_per_runtime: skippedPerRuntime,
    global_running_before: currentlyRunning,
  };
}

// Run a single execution and persist everything. Reusable by both the
// scheduler tick and the manual run-now route. Dispatches by
// runtime.kind: 'agent' (Phase 1) stays inline below; 'system'
// (Phase 2) routes to lib/engine/system/runtime/scheduler.ts. The
// shared bits (governance gate, runs-row lifecycle, ledger, audit,
// auto-pause threshold) are the same on both branches.
export async function runOnce(
  supabase: ForgeSupabase,
  runtime: AgentRuntime,
  trigger: AgentRunTrigger,
): Promise<void> {
  // Phase 2 dispatch — system runtimes have their own executor + run
  // context loader (parses SystemSpec + OrchestrationPlan).
  // Dynamic import keeps the agent path's import graph identical and
  // avoids a circular dependency.
  if (runtime.kind === 'system') {
    const { runSystemOnce } = await import(
      '@/lib/engine/system/runtime/scheduler'
    );
    return runSystemOnce(supabase, runtime, trigger);
  }

  // Re-validate: a runtime that was activated weeks ago may now reference
  // a stale spec/plan/build. Defensive reload.
  const ctx = await loadRunContext(supabase, runtime);
  if ('error' in ctx) {
    await audit(supabase, {
      projectId: runtime.project_id,
      action: 'run.failed',
      actor: 'engine.runtime',
      detail: { runtime_id: runtime.id, error: ctx.error },
    });
    return;
  }

  // --- governance gate per run ------------------------------------------
  // Look up the owning user via the project so the guard can apply per-user
  // budgets + scoped kill switches.
  const { data: projectRow } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', runtime.project_id)
    .single();
  const userId = (projectRow as { user_id: string | null } | null)?.user_id ?? null;

  // Peek the user's E2B key situation so the per-run guard can apply the
  // right budget posture. BYOK runtimes only get kill-switched, never
  // budget-paused (their fuel, their bill).
  const peek = await peekKeySource(userId, 'e2b', supabase);
  const guardKeySource = peek.source === 'byok' ? 'byok' : 'platform';

  try {
    await assertAllowed(
      {
        user_id: userId,
        project_id: runtime.project_id,
        // Approximate this run's cost by assuming it uses the full max_run_ms.
        projectedCostUsd: projectedComputeCostUsd('runtime', runtime.max_run_ms),
        keySource: guardKeySource,
      },
      supabase,
    );
  } catch (err) {
    if (err instanceof GovernanceError) {
      await handleBudgetBlock(supabase, runtime, err);
      return;
    }
    throw err;
  }

  const runRow = await insertRunningRunRow(supabase, runtime.id, trigger);
  await audit(supabase, {
    projectId: runtime.project_id,
    action: 'run.started',
    actor: 'engine.runtime',
    detail: { runtime_id: runtime.id, run_id: runRow.id, trigger },
  });

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
        // Nothing actually executed — attribute the (zero) cost to the
        // platform rather than fabricating a BYOK event.
        key_source: 'platform',
      },
      scheduleNextTick: trigger === 'tick',
    });
    await audit(supabase, {
      projectId: runtime.project_id,
      action: 'run.failed',
      actor: 'engine.runtime',
      detail: { runtime_id: runtime.id, run_id: runRow.id, error: msg },
    });
    return;
  }

  const result = await executeAgentRun({
    spec: ctx.spec,
    plan: ctx.plan,
    files: ctx.files,
    env,
    maxRunMs: runtime.max_run_ms,
    user_id: userId,
  });
  // Drop the decrypted env from memory ASAP after the run.
  env = {};

  // Record real compute cost in the ledger. Failures inside recordCost
  // don't throw; the next guard call will catch a broken ledger.
  // key_source is what the executor actually used (BYOK or platform).
  void recordCost(
    {
      user_id: userId,
      project_id: runtime.project_id,
      kind: 'runtime',
      compute_ms: result.duration_ms,
      key_source: result.key_source,
      ref: 'runtime.' + trigger + '.' + runRow.id,
    },
    supabase,
  );

  const { autoPaused } = await finishRunRow(supabase, {
    runtime,
    runId: runRow.id,
    result,
    scheduleNextTick: trigger === 'tick',
  });

  await audit(supabase, {
    projectId: runtime.project_id,
    action: result.success ? 'run.succeeded' : 'run.failed',
    actor: 'engine.runtime',
    detail: {
      runtime_id: runtime.id,
      run_id: runRow.id,
      duration_ms: result.duration_ms,
      provider: result.provider,
      ...(result.success ? {} : { error: result.error }),
    },
  });

  if (autoPaused) {
    await audit(supabase, {
      projectId: runtime.project_id,
      action: 'runtime.auto_paused',
      actor: 'engine.runtime',
      detail: {
        runtime_id: runtime.id,
        consecutive_fails: runtime.consecutive_fails + 1,
      },
    });
  }
}

// --- Budget block handler --------------------------------------------------

// When a runtime hits its budget cap (or a scoped kill switch), we auto-pause
// it to 'errored' so the scheduler stops picking it up, and we audit the
// reason distinctly from a normal failure.
async function handleBudgetBlock(
  supabase: ForgeSupabase,
  runtime: AgentRuntime,
  err: GovernanceError,
): Promise<void> {
  const isKilled = err.reason === 'killed';
  const isProjectOrUserKill =
    isKilled && err.detail.scope !== 'global';

  // We pause both budget hits and project/user kill switches. Global kill
  // switches are handled at the tick-entry level — we shouldn't reach this
  // path for them, but if we somehow do, pausing is safe.
  await supabase
    .from('agent_runtimes')
    .update({ status: 'errored', next_run_at: null })
    .eq('id', runtime.id);

  await audit(supabase, {
    projectId: runtime.project_id,
    action:
      err.reason === 'budget'
        ? 'runtime.budget_paused'
        : isProjectOrUserKill
          ? 'action.blocked_killswitch'
          : 'action.blocked_budget',
    actor: 'engine.governance',
    detail: {
      runtime_id: runtime.id,
      reason: err.reason,
      ...err.detail,
    },
  });
}

// --- Context loader (lighter than persistence.loadRuntimeContext) ----------

interface RunContext {
  spec: AgentSpec;
  plan: BuildPlan;
  files: BuildFile[];
}

async function loadRunContext(
  supabase: ForgeSupabase,
  runtime: AgentRuntime,
): Promise<RunContext | { error: string }> {
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
  const parsedSpec = AgentSpecSchema.safeParse(spec.structured_spec);
  if (!parsedSpec.success) {
    return { error: 'spec no longer matches schema' };
  }

  const { data: planRow } = await supabase
    .from('plans')
    .select('*')
    .eq('id', build.plan_id)
    .single();
  const plan = (planRow as Plan | null) ?? null;
  if (!plan) return { error: 'plan missing' };
  const parsedPlan = BuildPlanSchema.safeParse(plan.plan);
  if (!parsedPlan.success) {
    return { error: 'plan no longer matches schema' };
  }

  const { data: files } = await supabase
    .from('build_files')
    .select('*')
    .eq('build_id', build.id)
    .order('path', { ascending: true });
  const buildFiles = (files ?? []) as BuildFile[];
  if (buildFiles.length === 0) return { error: 'no build files' };

  return { spec: parsedSpec.data, plan: parsedPlan.data, files: buildFiles };
}
