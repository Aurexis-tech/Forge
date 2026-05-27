// Phase 2 (Systems) runtime dashboard. REUSES the Phase 1 RuntimeView
// (status / cadence / RunsList / RuntimeControls — all kind-agnostic
// at the row level) and frames it with a system-specific banner that
// calls out the shared cost ceiling — the Phase 2 non-negotiable: one
// run = one governed unit, the budget + kill switch bind the WHOLE
// orchestration, not each agent.
//
// The pause/resume/stop/run-now control routes are kind-agnostic and
// reused as-is — they operate on the agent_runtimes row by id and the
// scheduler's `runOnce` dispatches to runSystemOnce when kind='system'.

import { GlassPanel } from '@/components/GlassPanel';
import { RuntimeView } from '@/components/runtime/RuntimeView';
import type { AgentRun, AgentRuntime } from '@/lib/types';

interface Props {
  projectId: string;
  runtime: AgentRuntime;
  runs: AgentRun[];
  // The OrchestrationPlan node count — surfaced in the banner so the
  // reviewer knows "one run executes N sub-agents".
  nodeCount: number;
  // Shared-ceiling readout: the project's running cost since the
  // runtime activated, formatted as USD. Pulled from the Phase 1 cost
  // ledger via the existing helper in the page.
  costToDateUsd: number;
}

export function SystemRuntimePanel({
  projectId,
  runtime,
  runs,
  nodeCount,
  costToDateUsd,
}: Props) {
  return (
    <div className="flex flex-col gap-5">
      <GlassPanel className="border-forge-cyan/30">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-forge-cyan shadow-cyan"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              system runtime · live
            </h2>
          </div>
          <p className="text-sm text-forge-dim">
            One run executes {nodeCount} sub-agent{nodeCount === 1 ? '' : 's'}{' '}
            as a coordinated unit via the generated orchestrator. The
            max-steps ceiling + per-handoff validation are baked into the
            orchestrator at codegen — a runaway or a bad handoff surfaces as
            a clean run failure. Three consecutive failures auto-pause the
            runtime.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              label="cost ceiling"
              value="one run · one governed unit"
              tone="amber"
            />
            <Stat
              label="cost since activation"
              value={'$' + costToDateUsd.toFixed(4)}
              tone="cyan"
            />
            <Stat
              label="kill switch"
              value="halts whole run mid-flight"
              tone="rose"
            />
          </div>

          <p className="rounded-lg border border-forge-amber/30 bg-forge-amber/[0.05] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
            shared ceiling · budget + kill switch bind the WHOLE run, not
            each agent
          </p>
        </div>
      </GlassPanel>

      <RuntimeView projectId={projectId} runtime={runtime} runs={runs} />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'amber' | 'cyan' | 'rose';
}) {
  const toneClass =
    tone === 'amber'
      ? 'text-forge-amber'
      : tone === 'cyan'
        ? 'text-forge-cyan'
        : 'text-rose-300';
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        {label}
      </p>
      <p className={'mt-1 font-mono text-xs ' + toneClass}>{value}</p>
    </div>
  );
}
