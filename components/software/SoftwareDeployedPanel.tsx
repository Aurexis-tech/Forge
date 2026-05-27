// Phase 3-5b read-only banner shown once a software build has reached
// 'deployed'. Same shape as the system DeployedPanel — surfaces the
// safe-to-display deploy URL + the env classification recap, and the
// locked-next-step note.
//
// SECURITY: this component only receives KEY NAMES + the deploy URL.
// No env values, no anon key, and absolutely no service-role.

import { GlassPanel } from '@/components/GlassPanel';

interface Props {
  deployUrl: string;
  repoUrl: string | null;
  accountLogin: string;
  publicEnvKeys: string[];
  serverOnlyEnvKeys: string[];
}

export function SoftwareDeployedPanel({
  deployUrl,
  repoUrl,
  accountLogin,
  publicEnvKeys,
  serverOnlyEnvKeys,
}: Props) {
  return (
    <GlassPanel className="border-emerald-400/40 shadow-amber">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-emerald-300">
            software app · deployed
          </h2>
        </div>
        <ul className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-[11px]">
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">vercel account</span>
            <span className="text-forge-text">@{accountLogin}</span>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">deploy url</span>
            <a
              href={deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-emerald-300 hover:underline"
            >
              {deployUrl}
            </a>
          </li>
          {repoUrl ? (
            <li className="flex flex-wrap items-baseline gap-2">
              <span className="text-forge-dim">repo</span>
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-forge-cyan hover:underline"
              >
                {repoUrl}
              </a>
            </li>
          ) : null}
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">public env</span>
            <span className="break-all text-forge-text">
              {publicEnvKeys.length > 0 ? publicEnvKeys.join(', ') : 'none'}
            </span>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">server-only env</span>
            <span className="break-all text-forge-text">
              {serverOnlyEnvKeys.length > 0
                ? serverOnlyEnvKeys.join(', ') + ' · encrypted on vercel'
                : 'none'}
            </span>
          </li>
        </ul>
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · runtime + app dashboard lands next
        </p>
      </div>
    </GlassPanel>
  );
}
