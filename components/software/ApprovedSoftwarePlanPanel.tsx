// Approved-state panel for the Phase 3 software build plan. Mirrors
// ApprovedOrchestrationPanel; the build pipeline lands in a later phase.

import { GlassPanel } from '@/components/GlassPanel';
import { SoftwareBuildPlanView } from './SoftwareBuildPlanView';
import type { SoftwareBuildPlan } from '@/lib/engine/software/planner/schema';

export function ApprovedSoftwarePlanPanel({
  plan,
}: {
  plan: SoftwareBuildPlan;
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
            build plan · approved
          </h2>
        </div>
        <SoftwareBuildPlanView plan={plan} />
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · phase 3 ends here · software code generation lands in a later phase
        </p>
      </div>
    </GlassPanel>
  );
}
