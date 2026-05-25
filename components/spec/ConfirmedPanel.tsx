import { GlassPanel } from '@/components/GlassPanel';
import { SpecView } from './SpecView';
import type { AgentSpec } from '@/lib/engine/spec/schema';

export function ConfirmedPanel({ spec }: { spec: AgentSpec }) {
  return (
    <GlassPanel className="border-forge-amber/30 shadow-amber">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            spec · confirmed
          </h2>
        </div>
        <SpecView spec={spec} />
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked. the build pipeline can now consume this spec.
        </p>
      </div>
    </GlassPanel>
  );
}
