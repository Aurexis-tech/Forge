// ProjectGovernancePanel — the per-project Governance section on
// /projects/[id]. AI-futuristic (LiquidGlass, lq tokens, font-ui on
// headings), inherits the Deep field backdrop. Server component, pure
// presentation: the page loads the real data and passes it in; this only
// renders. Every panel binds to a REAL source (see lib/project-governance):
//
//   • Header        — eyebrow GOVERNANCE + project name + mold badge.
//   • Stat strip     — spend (USD), gate-decision count, runtime status.
//                      "—" where a source isn't present (no runtime row).
//   • Authorization history — real AuthorizationGate decisions from audit_log.
//   • Spend          — this project's real spend (no per-project cap exists,
//                      so spendZone reports NO CAP SET honestly).
//   • Activity       — the project's real audit_log rows.
//   • Runtime monitoring — HONEST EMPTY STATE. No fabricated action feed,
//                      and no accept-or-halt controls — the artifact can't
//                      be gated post-deploy yet, so wiring dead controls
//                      would be a false safety claim.
//
// No new infinite animation is introduced here.

import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { MOLD_META, resolveProjectMold } from '@/lib/molds';
import {
  formatHeroSpend,
  spendZone,
  type SpendColor,
} from '@/lib/governance-zones';
import {
  activityVm,
  authorizationHistoryVm,
  governanceStatsVm,
  RUNTIME_MONITORING_COPY,
  type AuthDecisionTone,
} from '@/lib/project-governance';
import type { AuditLog, Project, Spec } from '@/lib/types';

const TONE_TEXT: Record<SpendColor | 'ink-dim' | 'violet', string> = {
  mint: 'text-lq-mint',
  aurora: 'text-lq-aurora',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
  violet: 'text-lq-violet',
  'ink-dim': 'text-lq-ink-faint',
};
const TONE_DOT: Record<SpendColor | 'ink-dim' | 'violet', string> = {
  mint: 'bg-lq-mint',
  aurora: 'bg-lq-aurora',
  amber: 'bg-lq-amber',
  rose: 'bg-lq-rose',
  violet: 'bg-lq-violet',
  'ink-dim': 'bg-lq-ink-faint',
};

const AUTH_TONE_COLOR: Record<AuthDecisionTone, SpendColor | 'ink-dim'> = {
  approved: 'mint',
  halt: 'rose',
  neutral: 'aurora',
};

// Deterministic UTC stamp — "2026-06-03 14:22 UTC". Avoids locale/timezone
// drift (this renders on the server) and never fabricates precision.
function stamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function ProjectGovernancePanel({
  project,
  spec,
  auditRows,
  spendUsd,
  runtimeStatus,
}: {
  project: Project;
  spec: Spec | null;
  auditRows: ReadonlyArray<AuditLog>;
  spendUsd: number;
  runtimeStatus: string | null;
}) {
  const mold = resolveProjectMold(project, spec);
  const moldMeta = MOLD_META[mold];
  const stats = governanceStatsVm({ spendUsd, auditRows, runtimeStatus });
  const authHistory = authorizationHistoryVm(auditRows);
  const activity = activityVm(auditRows);
  const spend = formatHeroSpend(stats.spendUsd);
  const zone = spendZone(stats.spendUsd, null); // no per-project cap → NO CAP SET

  return (
    <section
      aria-label="Governance"
      className="flex flex-col gap-6 border-t border-lq-line pt-8 font-ui"
    >
      {/* Header — eyebrow + project name + mold badge. */}
      <header className="flex flex-col gap-2">
        <span className="font-code text-[10px] uppercase tracking-[0.4em] text-lq-aurora">
          Governance
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-ui text-2xl font-extrabold tracking-[-0.02em] text-lq-ink">
            {project.name}
          </h2>
          <span
            className="inline-flex items-center rounded-full border border-lq-line px-2 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint"
            title={moldMeta.description}
          >
            {moldMeta.badgeLabel}
          </span>
        </div>
        <p className="text-sm text-lq-ink-dim">
          What the Forge monitors and controls for this project — bound to
          real signals only.
        </p>
      </header>

      {/* Stat strip — real-sourced metrics only. */}
      <LiquidGlass
        as="div"
        className="grid grid-cols-1 divide-y divide-lq-line rounded-[14px] p-0 sm:grid-cols-3 sm:divide-x sm:divide-y-0"
      >
        <Stat
          label="Spend"
          value={'$' + stats.spendUsd.toFixed(2)}
          tone="mint"
        />
        <Stat
          label="Gate decisions"
          value={String(stats.gateDecisions)}
          tone="aurora"
        />
        <Stat
          label="Runtime"
          value={stats.runtime ? stats.runtime.label : '—'}
          tone={stats.runtime?.live ? 'aurora' : 'ink-dim'}
        />
      </LiquidGlass>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Authorization history — REAL gate decisions. */}
        <LiquidGlass as="div" className="flex flex-col gap-4 p-6 font-ui">
          <div className="flex items-end justify-between gap-2">
            <h3 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
              Authorization history
            </h3>
            <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
              {authHistory.length}{' '}
              {authHistory.length === 1 ? 'decision' : 'decisions'}
            </span>
          </div>
          {authHistory.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-lq-line bg-lq-elev-1/50 px-4 py-5 text-center font-code text-[12px] text-lq-ink-faint">
              No authorizations yet — they appear as the forge requests
              repo / deploy.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {authHistory.map((e) => (
                <li
                  key={e.id}
                  className="flex items-start gap-3 rounded-[10px] border border-lq-line bg-lq-elev-1 px-3 py-2"
                >
                  <span
                    aria-hidden
                    className={
                      'mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ' +
                      TONE_DOT[AUTH_TONE_COLOR[e.tone]]
                    }
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="font-ui text-sm text-lq-ink">
                      {e.label}
                    </span>
                    <span className="font-code text-[10px] uppercase tracking-[0.2em] text-lq-ink-faint">
                      {e.actor} · {stamp(e.at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </LiquidGlass>

        {/* Spend — REAL, reusing the spendZone tones. */}
        <LiquidGlass as="div" className="flex flex-col gap-4 p-6 font-ui">
          <div className="flex items-end justify-between gap-2">
            <h3 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
              Spend
            </h3>
            <span
              className={
                'inline-flex items-center rounded-full border border-lq-line px-2.5 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] ' +
                TONE_TEXT[zone.color]
              }
            >
              {zone.label}
            </span>
          </div>
          <p className="font-ui text-4xl font-extrabold tracking-[-0.02em] text-lq-ink">
            {spend.dollars}
            <span className="text-2xl text-lq-ink-dim">{spend.cents}</span>
          </p>
          <p className="font-code text-[11px] text-lq-ink-faint">
            {zone.headroom} · this project, to date (real)
          </p>
        </LiquidGlass>
      </div>

      {/* Activity — REAL audit_log rows. */}
      <LiquidGlass as="div" className="flex flex-col gap-4 p-6 font-ui">
        <div className="flex items-end justify-between gap-2">
          <h3 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
            Activity
          </h3>
          <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            {activity.length} {activity.length === 1 ? 'event' : 'events'}
          </span>
        </div>
        {activity.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-lq-line bg-lq-elev-1/50 px-4 py-5 text-center font-code text-[12px] text-lq-ink-faint">
            No activity logged yet for this project.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {activity.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[8px] px-2 py-1.5 font-code text-[11px] hover:bg-lq-elev-1"
              >
                <span
                  aria-hidden
                  className={
                    'inline-block h-1.5 w-1.5 shrink-0 rounded-full ' +
                    TONE_DOT[e.tone]
                  }
                />
                <span className={'uppercase tracking-[0.2em] ' + TONE_TEXT[e.tone]}>
                  {e.actor}
                </span>
                <span className="min-w-0 flex-1 truncate text-lq-ink-dim">
                  {e.action}
                </span>
                <span className="text-lq-ink-faint">{stamp(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </LiquidGlass>

      {/* Runtime monitoring — HONEST EMPTY STATE. No fabricated feed, no
          accept-or-halt controls. This becomes real when the engine learns
          to instrument deployed artifacts (separate work). */}
      <LiquidGlass
        as="div"
        className="flex flex-col gap-3 border-l-2 border-l-lq-line p-6 font-ui"
      >
        <span className="font-code text-[10px] uppercase tracking-[0.4em] text-lq-ink-faint">
          {RUNTIME_MONITORING_COPY.eyebrow}
        </span>
        <h3 className="font-ui text-lg font-bold tracking-tight text-lq-ink-dim">
          {RUNTIME_MONITORING_COPY.headline}
        </h3>
        <p className="max-w-2xl text-sm leading-relaxed text-lq-ink-faint">
          {RUNTIME_MONITORING_COPY.body}
        </p>
      </LiquidGlass>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: SpendColor | 'ink-dim' | 'violet';
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-5 py-4">
      <span className={'font-ui text-2xl font-bold tabular-nums ' + TONE_TEXT[tone]}>
        {value}
      </span>
      <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
        {label}
      </span>
    </div>
  );
}
