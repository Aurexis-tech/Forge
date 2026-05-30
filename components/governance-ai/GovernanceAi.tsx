// GovernanceAi — the design-study layout, recomposed (this commit) over
// the SAME real data the page already loads:
//   - daily + monthly spend from getSpendUsd
//   - real per-user cap from the `budgets` table
//   - the real global kill switch (mounted as a client island)
//   - real active runtimes (joined from agent_runtimes × projects)
//   - real cost events from getRecentCostEvents
//   - real audit_log rows
//
// LAYOUT (design-study exact):
//   header (eyebrow + h1 + sub)
//   ┌───────────────────────────────────┬───────────────┐
//   │  HERO monthly spend meter (big)   │               │
//   │  ─ DAILY secondary readout        │   Activity    │
//   │  KILL SWITCH (compact rose panel) │   stream      │
//   │  ACTIVE RUNTIMES (fills rest)     │  (full col)   │
//   └───────────────────────────────────┴───────────────┘
//
// No fake activity graphs, no invented numbers — only the fields the
// ledger + audit_log actually return. The meter fill is a bounded CSS
// transition (one-shot), never an infinite loop animating fake values.

import Link from 'next/link';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import {
  auditActorTone,
  costEventTone,
  meterFill,
  runtimeMoldColor,
  runtimeStatusVm,
  spendZone,
  type SpendColor,
} from '@/lib/governance-zones';
import type {
  AgentRuntime,
  AuditLog,
  Budget,
  CostEvent,
  KillSwitch,
} from '@/lib/types';
import { formatCurrency } from '@/lib/currencies';
import { BudgetFormAi } from './BudgetFormAi';
import { HeroSpendMeterAi } from './HeroSpendMeterAi';
import { KillSwitchAi } from './KillSwitchAi';
import styles from './governance.module.css';

export interface PeriodPanelData {
  spendUsd: number;
  budget: Budget | null;
  spendDisplay: number;
  limitDisplay: number | null;
  displayCurrency: string;
}

export interface GovernanceData {
  daily: PeriodPanelData;
  monthly: PeriodPanelData;
  globalKill: KillSwitch | null;
  events: CostEvent[];
  audit: AuditLog[];
  activeRuntimes: Array<AgentRuntime & { project_name?: string }>;
  fxNote: string;
}

interface Props {
  data: GovernanceData;
  userEmail: string | null;
}

export function GovernanceAi({ data, userEmail }: Props) {
  return (
    <section className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-8 px-2 py-12 font-ui text-lq-ink">
      {/* Header — eyebrow + h1 + sub + sign-out (real action). */}
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="h-px w-9 bg-lq-aurora/60"
          />
          <span className="font-code text-[11px] uppercase tracking-[0.35em] text-lq-aurora">
            Governance · Ceiling + Kill Switch
          </span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-ui text-[52px] font-bold leading-[1.02] tracking-[-0.02em] text-lq-ink">
            Power, on a leash.
          </h1>
          <div className="flex items-center gap-3 font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            <span>signed in · {userEmail ?? 'user'}</span>
            <form action="/api/auth/sign-out" method="POST">
              <button
                type="submit"
                className="rounded-[10px] border border-lq-line px-3 py-1 transition hover:border-lq-aurora/50 hover:text-lq-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60"
              >
                sign out
              </button>
            </form>
          </div>
        </div>
        <p className="max-w-[680px] text-sm leading-relaxed text-lq-ink-dim">
          <span className="text-lq-ink">Every running project</span> sits inside
          one hard spend ceiling.{' '}
          <span className="text-lq-ink">Watch it warm in real time.</span>{' '}
          <span className="text-lq-ink">Pull the lever</span> any second to
          freeze everything.
        </p>
      </header>

      {/* Two-column grid — left 1.45fr / right 1fr, gap 24px. */}
      <div
        className="grid grid-cols-1 gap-6 lg:grid-cols-[1.45fr_1fr]"
      >
        {/* LEFT column. */}
        <div className="flex min-w-0 flex-col gap-6">
          <HeroSpendMeterAi
            spendUsd={data.monthly.spendUsd}
            budget={data.monthly.budget}
            spendDisplay={data.monthly.spendDisplay}
            limitDisplay={data.monthly.limitDisplay}
            displayCurrency={data.monthly.displayCurrency}
            fxNote={data.fxNote}
          />

          <DailySpendReadout panel={data.daily} fxNote={data.fxNote} />

          <KillSwitchAi
            active={!!data.globalKill && data.globalKill.scope === 'global'}
            reason={data.globalKill?.reason ?? null}
            setBy={data.globalKill?.set_by ?? null}
            engagedAtIso={data.globalKill?.created_at ?? null}
          />

          <ActiveRuntimesList
            runtimes={data.activeRuntimes}
            dailySpendUsd={data.daily.spendUsd}
            dailySpendDisplay={data.daily.spendDisplay}
            dailyCurrency={data.daily.displayCurrency}
          />
        </div>

        {/* RIGHT column — full-height Activity stream. */}
        <div className="min-w-0">
          <ActivityStream events={data.events} audit={data.audit} />
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// Daily spend — compact secondary readout under the monthly hero
// ===========================================================================

const ZONE_TEXT: Record<SpendColor, string> = {
  mint: 'text-lq-mint',
  aurora: 'text-lq-aurora',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
};
const ZONE_DOT: Record<SpendColor, string> = {
  mint: 'bg-lq-mint',
  aurora: 'bg-lq-aurora',
  amber: 'bg-lq-amber',
  rose: 'bg-lq-rose',
};
const ZONE_FILL_CLASS: Record<SpendColor, string> = {
  mint: styles.meterFillMint!,
  aurora: styles.meterFillAurora!,
  amber: styles.meterFillAmber!,
  rose: styles.meterFillRose!,
};

function DailySpendReadout({
  panel,
  fxNote,
}: {
  panel: PeriodPanelData;
  fxNote: string;
}) {
  const limitUsd = panel.budget ? Number(panel.budget.limit_usd) : null;
  const vm = spendZone(panel.spendUsd, limitUsd);
  const fillPct = meterFill(panel.spendUsd, limitUsd) * 100;
  const isNonUsd = panel.displayCurrency.toUpperCase() !== 'USD';
  const hasCap = limitUsd != null && limitUsd > 0;

  return (
    <LiquidGlass as="div" className="flex flex-col gap-3 p-5 font-ui">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden
            className={'inline-block h-1.5 w-1.5 rounded-full ' + ZONE_DOT[vm.color]}
          />
          <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-dim">
            Daily spend · today
          </span>
          <span
            className={
              'font-code text-[10px] uppercase tracking-[0.3em] ' + ZONE_TEXT[vm.color]
            }
          >
            · {vm.label}
          </span>
        </div>
        <p className="font-code text-[12px] tabular-nums text-lq-ink">
          {formatCurrency(panel.spendDisplay, panel.displayCurrency)}
          {hasCap && panel.limitDisplay != null ? (
            <span className="text-lq-ink-dim">
              {' '}/ {formatCurrency(panel.limitDisplay, panel.displayCurrency)} daily
            </span>
          ) : (
            <span className="text-lq-ink-faint"> · no cap</span>
          )}
        </p>
      </div>

      <div
        className={
          styles.meterTrack + ' ' + styles.meterTrackSmall +
          (hasCap ? '' : ' ' + styles.meterEmptyTrack)
        }
      >
        {hasCap ? (
          <div
            className={styles.meterFill + ' ' + ZONE_FILL_CLASS[vm.color]}
            style={{ width: fillPct + '%' }}
            aria-hidden
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-code text-[10px] text-lq-ink-faint">{vm.headroom}</p>
        <div className="flex items-center gap-2">
          {isNonUsd ? (
            <p
              className="font-code text-[10px] text-lq-ink-faint"
              title={fxNote}
            >
              ${panel.spendUsd.toFixed(2)} USD
            </p>
          ) : null}
          <BudgetFormAi
            period="daily"
            current={panel.budget}
            currentDisplayAmount={panel.limitDisplay}
            size="compact"
          />
        </div>
      </div>
    </LiquidGlass>
  );
}

// ===========================================================================
// Active runtimes — REAL agent_runtimes, mold-colored badges, no per-row
// inline actions (the per-runtime controls don't exist as endpoints today)
// ===========================================================================

const MOLD_BADGE_CLASS: Record<string, string> = {
  aurora: 'border-lq-aurora/40 bg-lq-aurora/10 text-lq-aurora',
  violet: 'border-lq-violet/40 bg-lq-violet/10 text-lq-violet',
  mint: 'border-lq-mint/40 bg-lq-mint/10 text-lq-mint',
  amber: 'border-lq-amber/40 bg-lq-amber/10 text-lq-amber',
  'ink-dim': 'border-lq-line bg-lq-elev-1 text-lq-ink-dim',
};

function ActiveRuntimesList({
  runtimes,
  dailySpendUsd,
  dailySpendDisplay,
  dailyCurrency,
}: {
  runtimes: ReadonlyArray<AgentRuntime & { project_name?: string }>;
  dailySpendUsd: number;
  dailySpendDisplay: number;
  dailyCurrency: string;
}) {
  const runningCount = runtimes.filter((r) => r.status === 'active').length;
  const spentTodayLabel =
    dailySpendUsd > 0
      ? formatCurrency(dailySpendDisplay, dailyCurrency) + ' spent today'
      : '$0 spent today';

  return (
    <LiquidGlass as="div" className="flex flex-1 flex-col gap-3 p-6 font-ui">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
          Active runtimes
        </h3>
        <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
          {runningCount} {runningCount === 1 ? 'project' : 'projects'} running ·{' '}
          {spentTodayLabel}
        </span>
      </div>

      {runtimes.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-lq-line bg-lq-elev-1 px-4 py-6 text-center text-sm text-lq-ink-dim">
          No active runtimes yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {runtimes.map((rt) => {
            const vm = runtimeStatusVm(rt.status);
            const mold = runtimeMoldColor(rt.kind);
            return (
              <li
                key={rt.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-lq-line bg-lq-elev-1 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={
                      'rounded-full border px-2 py-0.5 font-code text-[10px] uppercase tracking-[0.25em] ' +
                      (MOLD_BADGE_CLASS[mold] ?? MOLD_BADGE_CLASS['ink-dim']!)
                    }
                  >
                    {rt.kind}
                  </span>
                  <Link
                    href={'/projects/' + rt.project_id}
                    className="min-w-0 truncate rounded font-ui text-sm font-medium text-lq-ink hover:text-lq-aurora hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60"
                  >
                    {rt.project_name ?? rt.project_id.slice(0, 8)}
                  </Link>
                </div>
                <div className="flex items-center gap-3 font-code text-[10px] uppercase tracking-[0.25em] text-lq-ink-faint">
                  <span className="text-right">
                    {rt.mode}
                    {rt.schedule_cron ? ' · ' + rt.schedule_cron : ''}
                    {' · '}
                    {rt.run_count} runs
                  </span>
                  {vm.live ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-lq-mint/40 bg-lq-mint/10 px-2 py-0.5 text-lq-mint">
                      <span
                        aria-hidden
                        className={'inline-block h-1.5 w-1.5 rounded-full bg-lq-mint ' + styles.livePulseDot}
                      />
                      Live
                    </span>
                  ) : (
                    <span
                      className={
                        'inline-flex items-center rounded-full border px-2 py-0.5 ' +
                        (vm.color === 'rose'
                          ? 'border-lq-rose/40 bg-lq-rose/10 text-lq-rose'
                          : 'border-lq-line bg-lq-elev-1 text-lq-ink-dim')
                      }
                    >
                      {vm.label}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </LiquidGlass>
  );
}

// ===========================================================================
// Activity stream — RIGHT column, full-height, real events
// ===========================================================================

interface StreamRow {
  /** Stable key. */
  key: string;
  /** Real timestamp in ms — for sorting. */
  tsMs: number;
  /** Real timestamp string for display (locale). */
  when: string;
  /** Tone color from the real source. */
  tone: SpendColor | 'ink-dim';
  /** Eyebrow chip (kind/actor). */
  chip: string;
  /** The primary message — real. */
  message: string;
  /** Optional trailing meta. */
  meta?: string;
}

const STREAM_TEXT: Record<SpendColor | 'ink-dim', string> = {
  mint: 'text-lq-mint',
  aurora: 'text-lq-aurora',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
  'ink-dim': 'text-lq-ink-dim',
};

const STREAM_BORDER: Record<SpendColor | 'ink-dim', string> = {
  mint: 'border-lq-mint/40',
  aurora: 'border-lq-aurora/40',
  amber: 'border-lq-amber/40',
  rose: 'border-lq-rose/40',
  'ink-dim': 'border-lq-line',
};

function buildStreamRows(
  events: ReadonlyArray<CostEvent>,
  audit: ReadonlyArray<AuditLog>,
): ReadonlyArray<StreamRow> {
  const rows: StreamRow[] = [];

  for (const e of events) {
    const tone = costEventTone(e.kind);
    const tsMs = new Date(e.created_at).getTime();
    const cost = '$' + Number(e.amount_usd).toFixed(4);
    const parts: string[] = [];
    if (e.model) parts.push(e.model);
    if (e.input_tokens || e.output_tokens) {
      parts.push(e.input_tokens + ' in / ' + e.output_tokens + ' out');
    }
    if (e.compute_ms) parts.push(e.compute_ms + ' ms');
    if (e.ref) parts.push(e.ref);
    rows.push({
      key: 'e:' + e.id,
      tsMs,
      when: new Date(e.created_at).toLocaleString(),
      tone,
      chip: e.kind,
      message: parts.length > 0 ? parts.join(' · ') : e.kind,
      meta: cost,
    });
  }

  for (const a of audit) {
    const tone = auditActorTone(a.actor);
    const tsMs = new Date(a.created_at).getTime();
    rows.push({
      key: 'a:' + a.id,
      tsMs,
      when: new Date(a.created_at).toLocaleString(),
      tone,
      chip: a.actor,
      message: a.action,
      meta: a.project_id ? 'project · ' + a.project_id.slice(0, 8) : undefined,
    });
  }

  // Most recent first.
  rows.sort((a, b) => b.tsMs - a.tsMs);
  return rows;
}

function ActivityStream({
  events,
  audit,
}: {
  events: ReadonlyArray<CostEvent>;
  audit: ReadonlyArray<AuditLog>;
}) {
  const rows = buildStreamRows(events, audit);

  return (
    <LiquidGlass
      as="div"
      className="flex h-full min-h-[600px] flex-col gap-3 p-6 font-ui"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
          Activity
        </h3>
        <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
          recent · {rows.length} {rows.length === 1 ? 'event' : 'events'}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-lq-line bg-lq-elev-1 px-4 py-6 text-center text-sm text-lq-ink-dim">
          No activity yet.
        </p>
      ) : (
        <div
          className={
            'relative min-h-0 flex-1 overflow-hidden ' + styles.activityFade
          }
        >
          <ul className="flex h-full flex-col gap-1 overflow-y-auto pr-1">
            {rows.slice(0, 60).map((r) => (
              <li
                key={r.key}
                className="flex flex-col gap-1 rounded-[10px] border border-lq-line bg-lq-elev-1 px-3 py-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 font-code text-[10px] uppercase tracking-[0.25em]">
                  <span
                    className={
                      'rounded-full border px-1.5 py-0.5 ' +
                      STREAM_BORDER[r.tone] +
                      ' ' +
                      STREAM_TEXT[r.tone]
                    }
                  >
                    {r.chip}
                  </span>
                  <span className="text-lq-ink-faint">{r.when}</span>
                </div>
                <p className="font-code text-[12px] leading-relaxed text-lq-ink">
                  {r.message}
                </p>
                {r.meta ? (
                  <p className="font-code text-[10px] tabular-nums text-lq-ink-dim">
                    {r.meta}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </LiquidGlass>
  );
}
