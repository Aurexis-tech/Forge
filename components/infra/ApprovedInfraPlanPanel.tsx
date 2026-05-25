// Approved-state panel for the Phase 4 infrastructure provisioning
// plan. Mirrors ApprovedSoftwarePlanPanel; provisioning lands in a
// later phase.

import { GlassPanel } from '@/components/GlassPanel';
import { ProvisioningPlanView } from './ProvisioningPlanView';
import type { ProvisioningPlan } from '@/lib/engine/infra/planner/schema';

export function ApprovedInfraPlanPanel({
  plan,
}: {
  plan: ProvisioningPlan;
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
            provisioning plan · approved
          </h2>
        </div>
        <ProvisioningPlanView plan={plan} />
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · phase 4 ends here · infrastructure provisioning lands in a later phase
        </p>
      </div>
    </GlassPanel>
  );
}
