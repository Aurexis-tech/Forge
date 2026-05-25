// Approved-state panel for the Phase 2 orchestration plan. Mirrors
// ApprovedPlanPanel for agents but with an explicit "build pipeline
// not yet wired" note — Phase 2 stops here.

import { GlassPanel } from '@/components/GlassPanel';
import { OrchestrationPlanView } from './OrchestrationPlanView';
import type { OrchestrationPlan } from '@/lib/engine/system/planner/schema';

export function ApprovedOrchestrationPanel({
  plan,
}: {
  plan: OrchestrationPlan;
}) {
  return (
    <GlassPanel className="border-forge-amber/30 shadow-amber">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            orchestration · approved
          </h2>
        </div>
        <OrchestrationPlanView plan={plan} />
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · phase 2 ends here · system code generation lands in a later phase
        </p>
      </div>
    </GlassPanel>
  );
}
