// Read-only banner shown when a software build has reached
// 'provisioned'. Mirrors the system DeployedPanel shape — surfaces the
// safe-to-display connection metadata + the locked-next-step note.
//
// SECURITY: this component receives a PublicSoftwareDatabase only
// (sanitised at the persistence boundary). The service-role key is
// NEVER in props — only the last-4 display string is.

import { GlassPanel } from '@/components/GlassPanel';
import type { PublicSoftwareDatabase } from '@/lib/engine/software/db/persistence';

interface Props {
  db: PublicSoftwareDatabase;
}

export function ProvisionedDbPanel({ db }: Props) {
  return (
    <GlassPanel className="border-emerald-400/40 shadow-amber">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-amber"
          />
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-emerald-300">
            software db · provisioned
          </h2>
        </div>
        <ul className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-[11px]">
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">provider</span>
            <span className="text-forge-text">{db.provider_kind}</span>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">supabase url</span>
            <a
              href={db.supabase_url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-forge-cyan hover:underline"
            >
              {db.supabase_url}
            </a>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">anon key</span>
            <span className="break-all text-forge-text">
              {abbreviate(db.anon_key)}
            </span>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">service-role</span>
            <span className="text-forge-text">
              •••• {db.service_role_last4} · encrypted at rest · server-only
            </span>
          </li>
          {db.provider_project_ref ? (
            <li className="flex flex-wrap items-baseline gap-2">
              <span className="text-forge-dim">project ref</span>
              <span className="text-forge-text">{db.provider_project_ref}</span>
            </li>
          ) : null}
          <li className="flex flex-wrap items-baseline gap-2">
            <span className="text-forge-dim">schema applied</span>
            <span
              className={
                db.migration_applied ? 'text-emerald-300' : 'text-rose-300'
              }
            >
              {db.migration_applied ? 'yes ✓' : 'no — retry to re-apply'}
            </span>
          </li>
        </ul>
        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · push + deploy lands next · the deployed app will use this exact connection
        </p>
      </div>
    </GlassPanel>
  );
}

// Show the first 6 + last 4 chars of a long token, hyphen between. The
// anon key is technically public (it's bundled into the browser
// bundle) but we still don't need to splash the full string in the UI.
function abbreviate(s: string): string {
  if (s.length <= 14) return s;
  return s.slice(0, 6) + '…' + s.slice(-4);
}
