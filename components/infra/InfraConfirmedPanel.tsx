// Confirmed-state panel for the Phase 4 InfraSpec. Mirrors the
// agent + system + software confirmed panels — locked, review-only
// badge, note that provisioning lands in a later phase.

import { GlassPanel } from '@/components/GlassPanel';
import { InfraSpecView } from './InfraSpecView';
import type { InfraSpec } from '@/lib/engine/infra/spec';

export function InfraConfirmedPanel({ spec }: { spec: InfraSpec }) {
  return (
    <GlassPanel className="border-forge-amber/30 shadow-amber">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            infrastructure spec · confirmed
          </h2>
        </div>
        <InfraSpecView spec={spec} />
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · phase 4 is review-only · provisioning lands later
        </p>
      </div>
    </GlassPanel>
  );
}
