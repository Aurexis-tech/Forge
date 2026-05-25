// Confirmed-state panel for a SystemSpec (Phase 2). Same visual rhythm
// as ConfirmedPanel for agents, with an explicit "review-only" note —
// the Phase 2 prompt explicitly scopes systems to intake; codegen,
// sandbox, deploy, and runtime are NOT extended yet.

import { GlassPanel } from '@/components/GlassPanel';
import { SystemSpecView } from './SystemSpecView';
import type { SystemSpec } from '@/lib/engine/system/spec';

export function SystemConfirmedPanel({ spec }: { spec: SystemSpec }) {
  return (
    <GlassPanel className="border-forge-amber/30 shadow-amber">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            system spec · confirmed
          </h2>
        </div>
        <SystemSpecView spec={spec} />
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · phase 2 is review-only · system code generation lands later
        </p>
      </div>
    </GlassPanel>
  );
}
