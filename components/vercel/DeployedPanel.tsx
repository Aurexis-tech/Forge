import { GlassPanel } from '@/components/GlassPanel';

interface Props {
  deployUrl: string;
  repoUrl: string | null;
  accountLogin: string;
  envKeys: string[];
}

export function DeployedPanel({
  deployUrl,
  repoUrl,
  accountLogin,
  envKeys,
}: Props) {
  return (
    <GlassPanel className="border-forge-amber/50 shadow-amber">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            agent · live
          </h2>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-forge-amber/30 bg-forge-amber/[0.05] p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
            your agent is live
          </p>
          <a
            href={deployUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all font-mono text-base text-forge-amber hover:underline"
          >
            {deployUrl}
          </a>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={deployUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-4 py-2 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25"
            >
              <span>Open agent</span>
              <span aria-hidden>↗</span>
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-black/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              vercel account
            </p>
            <p className="mt-1 font-mono text-sm text-forge-text">
              @{accountLogin}
            </p>
          </div>
          {repoUrl ? (
            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                source
              </p>
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 block break-all font-mono text-sm text-forge-cyan hover:underline"
              >
                {repoUrl}
              </a>
            </div>
          ) : null}
        </div>

        {envKeys.length > 0 ? (
          <div className="rounded-lg border border-white/10 bg-black/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              env keys set ({envKeys.length})
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {envKeys.map((k) => (
                <code
                  key={k}
                  className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] text-forge-text/90"
                >
                  {k}
                </code>
              ))}
            </div>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              values are stored only on vercel — not in forge
            </p>
          </div>
        ) : null}

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          the live url is public by design. add per-agent access control in
          your agent handler if needed.
        </p>
      </div>
    </GlassPanel>
  );
}
