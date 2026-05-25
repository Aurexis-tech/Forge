import { GlassPanel } from '@/components/GlassPanel';

interface Props {
  repoUrl: string;
  accountLogin: string;
  filesCount: number;
}

export function PushedPanel({ repoUrl, accountLogin, filesCount }: Props) {
  return (
    <GlassPanel className="border-forge-amber/30 shadow-amber">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            repo · pushed
          </h2>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              repository
            </span>
            <span className="rounded-full border border-forge-cyan/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-forge-cyan">
              private
            </span>
          </div>
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all font-mono text-sm text-forge-amber hover:underline"
          >
            {repoUrl}
          </a>
          <div className="flex flex-wrap gap-4 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            <span>account · @{accountLogin}</span>
            <span>files · {filesCount}</span>
            <span>commit · initial</span>
          </div>
        </div>

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          ready to ship. deploy stage arrives next (also gated by a human
          authorisation).
        </p>
      </div>
    </GlassPanel>
  );
}
