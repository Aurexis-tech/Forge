// Read-only view of a generated Phase 2 system build. Mirrors the
// Phase 1 GeneratedBuildPanel — same file-tree + preview, plus a
// locked-after-generation banner reminding the reviewer that the
// system pipeline stops here. System sandbox test, deploy, and
// runtime stay closed for kind='system' in this phase.

import { GlassPanel } from '@/components/GlassPanel';
import { BuildView } from '@/components/build/BuildView';
import type { StaticStatus } from '@/components/build/FileTree';
import type { BuildFile } from '@/lib/types';

interface StaticCheckEntry {
  path: string;
  status: StaticStatus;
  error?: string;
}

interface Props {
  files: BuildFile[];
  staticChecks: StaticCheckEntry[];
  warnings: string[];
  failedCount: number;
  orchestratorPath?: string | null;
  entrypointPath?: string | null;
  moduleCount?: number;
  // Phase 2-5 surfaces: once the system has been pushed / deployed,
  // we surface the URLs inline so the reviewer can jump from the file
  // tree to the live artefact in one click.
  repoUrl?: string | null;
  deployUrl?: string | null;
}

export function SystemBuildView({
  files,
  staticChecks,
  warnings,
  failedCount,
  orchestratorPath,
  entrypointPath,
  moduleCount,
  repoUrl,
  deployUrl,
}: Props) {
  const generatedCount = files.filter((f) => f.source === 'generated').length;
  const scaffoldCount = files.filter((f) => f.source === 'scaffold').length;

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
              system code · generated
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            phase 2 ends here · system sandbox test lands next
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-forge-text/90 sm:grid-cols-4">
          <Stat label="files" value={files.length} />
          <Stat label="scaffold" value={scaffoldCount} />
          <Stat label="generated" value={generatedCount} />
          <Stat
            label="modules"
            value={typeof moduleCount === 'number' ? moduleCount : '—'}
          />
        </div>

        {orchestratorPath || entrypointPath ? (
          <div className="rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[10px] text-forge-text/90">
            {orchestratorPath ? (
              <p>
                <span className="text-forge-dim">orchestrator:</span>{' '}
                {orchestratorPath}
              </p>
            ) : null}
            {entrypointPath ? (
              <p>
                <span className="text-forge-dim">entrypoint: </span>
                {entrypointPath}
              </p>
            ) : null}
            <p className="mt-2 text-forge-dim">
              orchestrator embeds the max-steps ceiling + per-handoff validation;
              each module exports `run(input)` and is invoked by the orchestrator
              in topological order.
            </p>
          </div>
        ) : null}

        {repoUrl || deployUrl ? (
          <div className="rounded-lg border border-forge-amber/30 bg-forge-amber/[0.05] p-3 font-mono text-[11px] text-forge-text/90">
            {repoUrl ? (
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="text-forge-dim">repo · private:</span>
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all text-forge-amber hover:underline"
                >
                  {repoUrl}
                </a>
              </p>
            ) : null}
            {deployUrl ? (
              <p className="mt-1 flex flex-wrap items-baseline gap-2">
                <span className="text-forge-dim">deploy · live:</span>
                <a
                  href={deployUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all text-forge-amber hover:underline"
                >
                  {deployUrl}
                </a>
              </p>
            ) : null}
          </div>
        ) : null}

        {failedCount > 0 ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {failedCount} file{failedCount === 1 ? '' : 's'} failed the
            per-file esbuild static check. The build is still stored for
            review; regenerate to retry.
          </p>
        ) : null}

        <BuildView
          files={files}
          staticChecks={staticChecks}
          warnings={warnings}
        />

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {deployUrl
            ? 'system deployed · runtime activation lands next · generated code is never executed by the forge host'
            : 'generated code is never executed at this layer · sandbox test + deploy land via the panels below'}
        </p>
      </div>
    </GlassPanel>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
      <p className="text-forge-dim">{label}</p>
      <p className="mt-1 text-base text-forge-amber">{value}</p>
    </div>
  );
}
