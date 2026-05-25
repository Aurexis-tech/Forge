import { GlassPanel } from '@/components/GlassPanel';
import { PlanView } from './PlanView';
import type { BuildPlan } from '@/lib/engine/planner/schema';

export function ApprovedPlanPanel({ plan }: { plan: BuildPlan }) {
  return (
    <GlassPanel className="border-forge-amber/30 shadow-amber">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            plan · approved
          </h2>
        </div>
        <PlanView plan={plan} />
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked. the codegen layer can now consume this plan.
        </p>
      </div>
    </GlassPanel>
  );
}
