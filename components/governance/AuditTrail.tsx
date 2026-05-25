import type { AuditLog } from '@/lib/types';

interface Props {
  rows: AuditLog[];
}

const ACTOR_TONE: Record<string, string> = {
  user: 'text-forge-amber',
  'engine.spec': 'text-forge-cyan',
  'engine.planner': 'text-forge-cyan',
  'engine.codegen': 'text-forge-cyan',
  'engine.sandbox': 'text-forge-cyan',
  'engine.runtime': 'text-forge-cyan',
  'engine.governance': 'text-rose-300',
  'integration.github': 'text-emerald-300',
  'integration.vercel': 'text-emerald-300',
};

export function AuditTrail({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-forge-dim">
        The audit trail is empty for the current view.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-white/5 rounded-xl border border-white/10 bg-black/30 font-mono text-xs">
      {rows.map((row) => (
        <li key={row.id} className="px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-forge-text">{row.action}</span>
            <span className="text-[10px] uppercase tracking-[0.25em] text-forge-dim">
              {new Date(row.created_at).toLocaleString()}
            </span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-2 text-[10px] uppercase tracking-[0.25em]">
            <span className={ACTOR_TONE[row.actor] ?? 'text-forge-dim'}>
              {row.actor}
            </span>
            {row.project_id ? (
              <span className="text-forge-dim">
                project · {row.project_id.slice(0, 8)}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
