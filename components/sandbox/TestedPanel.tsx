import { GlassPanel } from '@/components/GlassPanel';
import { TestView, type PhaseStatus } from './TestView';
import type { SandboxLogLine } from '@/lib/types';

interface Props {
  phases: PhaseStatus[];
  lines: SandboxLogLine[];
  buildOk: boolean | null;
  smokeOk: boolean | null;
  durationMs: number | null;
  provider: string;
}

export function TestedPanel({
  phases,
  lines,
  buildOk,
  smokeOk,
  durationMs,
  provider,
}: Props) {
  return (
    <GlassPanel className="border-forge-amber/30 shadow-amber">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              sandbox · tested
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            ready to ship (next stage)
          </p>
        </div>

        <TestView
          phases={phases}
          lines={lines}
          buildOk={buildOk}
          smokeOk={smokeOk}
          durationMs={durationMs}
          provider={provider}
          error={null}
        />

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          sandbox destroyed. github + deploy arrive in the next stage.
        </p>
      </div>
    </GlassPanel>
  );
}
