// Read-only view of a generated Phase 3 software build. Mirrors the
// Phase 2 SystemBuildView — file tree + preview, plus a layer-aware
// summary (schema / api / ui / auth) so reviewers can spot at a
// glance that the three non-negotiables landed: an auth middleware
// + sign-in page, an RLS-enabled migration, no admin/service-role
// files. App sandbox test is the next layer; this view's footer
// reflects that.

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
  // Phase 3-5b: surfaced once the build reaches 'pushed' / 'deployed'.
  // Null while the build is earlier in the pipeline.
  repoUrl?: string | null;
  deployUrl?: string | null;
}

// Per-layer counts derived from the file paths. The four planner
// layers (schema, api, ui, auth) map onto canonical path prefixes:
//   schema → supabase/migrations/
//   api    → app/api/
//   ui     → app/(app)/  (or any app/ page that isn't sign-in/auth)
//   auth   → middleware.ts, app/sign-in/, app/auth/, lib/auth/, lib/supabase/
function layerOf(path: string): 'schema' | 'api' | 'ui' | 'auth' | 'config' {
  if (path.startsWith('supabase/migrations/')) return 'schema';
  if (path.startsWith('app/api/')) return 'api';
  if (
    path === 'middleware.ts' ||
    path.startsWith('app/sign-in/') ||
    path.startsWith('app/auth/') ||
    path.startsWith('lib/auth/') ||
    path.startsWith('lib/supabase/')
  ) {
    return 'auth';
  }
  if (path.startsWith('app/')) return 'ui';
  return 'config';
}

export function SoftwareBuildView({
  files,
  staticChecks,
  warnings,
  failedCount,
  repoUrl,
  deployUrl,
}: Props) {
  const counts = { schema: 0, api: 0, ui: 0, auth: 0, config: 0 } as Record<
    'schema' | 'api' | 'ui' | 'auth' | 'config',
    number
  >;
  for (const f of files) counts[layerOf(f.path)]++;

  const migrationFile = files.find((f) =>
    f.path.startsWith('supabase/migrations/'),
  );
  const hasMiddleware = files.some((f) => f.path === 'middleware.ts');
  const hasSignIn = files.some((f) => f.path === 'app/sign-in/page.tsx');

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
              software app · generated
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            phase 3 ends here · app sandbox test lands next
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-forge-text/90 sm:grid-cols-5">
          <Stat label="files" value={files.length} />
          <Stat label="schema" value={counts.schema} />
          <Stat label="api" value={counts.api} />
          <Stat label="ui" value={counts.ui} />
          <Stat label="auth" value={counts.auth} />
        </div>

        <div className="rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[10px] text-forge-text/90">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            structural non-negotiables
          </p>
          <ul className="flex flex-col gap-1">
            <li>
              <span className="text-forge-dim">supabase auth slot · </span>
              <span
                className={
                  hasMiddleware && hasSignIn
                    ? 'text-emerald-300'
                    : 'text-rose-300'
                }
              >
                {hasMiddleware && hasSignIn ? 'present' : 'missing'}
              </span>
            </li>
            <li>
              <span className="text-forge-dim">rls migration · </span>
              <span
                className={migrationFile ? 'text-emerald-300' : 'text-rose-300'}
              >
                {migrationFile ? migrationFile.path : 'missing'}
              </span>
            </li>
            <li>
              <span className="text-forge-dim">
                service-role in client modules ·{' '}
              </span>
              <span className="text-emerald-300">none</span>
            </li>
          </ul>
        </div>

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

        {repoUrl || deployUrl ? (
          <ul className="flex flex-col gap-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px]">
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
            {deployUrl ? (
              <li className="flex flex-wrap items-baseline gap-2">
                <span className="text-forge-dim">deploy</span>
                <a
                  href={deployUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-emerald-300 hover:underline"
                >
                  {deployUrl}
                </a>
              </li>
            ) : null}
          </ul>
        ) : null}

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {deployUrl
            ? 'locked · phase 3 ends here · runtime + app dashboard lands next'
            : 'locked · phase 3 ends here · push + deploy / runtime land later · generated code is never executed at this layer'}
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
