import { GlassPanel } from '@/components/GlassPanel';

interface Props {
  runtimeImpl: 'always_on' | 'on_demand' | string;
  trigger: string;
}

// Shown when the spec/plan describes an always-on or scheduled agent.
// These are routed to the runtime layer (next commit) — never deployed to
// Vercel via the on-demand path.
export function DeployBlockedPanel({ runtimeImpl, trigger }: Props) {
  return (
    <GlassPanel className="border-forge-cyan/30">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-cyan"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            deploy · routed to runtime
          </h2>
        </div>
        <p className="text-sm text-forge-text/90">
          This agent runs continuously or on a schedule, so it doesn&apos;t
          ship via the on-demand Vercel path. Continue in the{' '}
          <span className="text-forge-text">Runtime</span> step (arriving in
          the next stage) — that layer is built to host long-lived /
          cron-triggered agents.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-black/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              runtime
            </p>
            <p className="mt-1 font-mono text-sm text-forge-text">
              {runtimeImpl}
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              trigger
            </p>
            <p className="mt-1 font-mono text-sm text-forge-text">{trigger}</p>
          </div>
        </div>
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          build status remains &lsquo;pushed&rsquo;. nothing was deployed.
        </p>
      </div>
    </GlassPanel>
  );
}
