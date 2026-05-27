// Read-only view of a generated Phase 4 infrastructure build. Mirrors
// the Phase 3 SoftwareBuildView shape — file tree + preview, plus a
// layer-aware summary (network / data / compute / observability) and a
// SECURE-DEFAULTS strip that surfaces the structural non-negotiables
// the composer baked in.
//
// SECURITY presentation: the SECURE-DEFAULTS strip carries the
// aggregated flags from the validator; the file tree groups every
// emitted .tf file by its layer directory so a reviewer can see at a
// glance "private network first, data stores, then workloads,
// observability last".

import { GlassPanel } from '@/components/GlassPanel';
import { BuildView } from '@/components/build/BuildView';
import type { StaticStatus } from '@/components/build/FileTree';
import type { BuildFile } from '@/lib/types';

interface StaticCheckEntry {
  path: string;
  status: StaticStatus;
  error?: string;
}

interface SecureDefaultFlags {
  private_by_default: boolean;
  tls: boolean;
  least_privilege_iam: boolean;
  kms_encryption: boolean;
}

interface Props {
  files: BuildFile[];
  staticChecks: StaticCheckEntry[];
  failedCount: number;
  secureDefaults: SecureDefaultFlags;
  publicOptIns: string[];
  moduleIdsUsed: string[];
}

function layerOf(path: string): 'network' | 'data' | 'compute' | 'observability' | 'versions' {
  if (path === 'infra/versions.tf') return 'versions';
  if (path.startsWith('infra/network/')) return 'network';
  if (path.startsWith('infra/data/')) return 'data';
  if (path.startsWith('infra/compute/')) return 'compute';
  if (path.startsWith('infra/observability/')) return 'observability';
  return 'versions'; // defensive; should never hit
}

export function InfraBuildView({
  files,
  staticChecks,
  failedCount,
  secureDefaults,
  publicOptIns,
  moduleIdsUsed,
}: Props) {
  const counts = {
    network: 0,
    data: 0,
    compute: 0,
    observability: 0,
    versions: 0,
  };
  for (const f of files) counts[layerOf(f.path)]++;

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
              infrastructure · generated
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            phase 4 ends here · preview + cost estimate lands next
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-forge-text/90 sm:grid-cols-5">
          <Stat label="files" value={files.length} />
          <Stat label="network" value={counts.network} />
          <Stat label="data" value={counts.data} />
          <Stat label="compute" value={counts.compute} />
          <Stat label="observability" value={counts.observability} />
        </div>

        <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-3 font-mono text-[10px] text-forge-text/90">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
            secure defaults · structural
          </p>
          <ul className="flex flex-col gap-1">
            <DefaultRow
              label="private-by-default"
              ok={secureDefaults.private_by_default}
            />
            <DefaultRow label="TLS" ok={secureDefaults.tls} />
            <DefaultRow
              label="least-privilege IAM"
              ok={secureDefaults.least_privilege_iam}
            />
            <DefaultRow label="KMS encryption" ok={secureDefaults.kms_encryption} />
          </ul>
          {publicOptIns.length > 0 ? (
            <p className="mt-2 text-[10px] text-forge-amber">
              public exposure opted in by spec for: {publicOptIns.join(', ')} · the
              P4-5 confirmation gate will surface these explicitly
            </p>
          ) : (
            <p className="mt-2 text-[10px] text-forge-dim">
              no public exposure — every resource is private by spec
            </p>
          )}
        </div>

        <div className="rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[10px] text-forge-text/90">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            modules used · vetted catalog only
          </p>
          <p className="text-[11px] text-forge-text">
            {moduleIdsUsed.length > 0 ? moduleIdsUsed.join(' · ') : '—'}
          </p>
        </div>

        {failedCount > 0 ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {failedCount} static-validation failure
            {failedCount === 1 ? '' : 's'}. The build is stored for review; the
            failure indicates a composer regression, not a user-fixable issue.
          </p>
        ) : null}

        <BuildView files={files} staticChecks={staticChecks} warnings={[]} />

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · phase 4 ends here · preview + cost estimate / provision +
          apply / runtime land later · nothing is applied at this layer · zero
          cloud calls
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

function DefaultRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li>
      <span className="text-forge-dim">{label} · </span>
      <span className={ok ? 'text-emerald-300' : 'text-rose-300'}>
        {ok ? '✓' : 'missing'}
      </span>
    </li>
  );
}
