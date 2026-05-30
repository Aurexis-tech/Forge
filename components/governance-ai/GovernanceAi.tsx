// GovernanceAi — the AI-futuristic /governance shell. Server component;
// takes the data the page already loads (so the page stays the single
// data source) and renders the LiquidGlass shell + AI palette on top of
// the SAME real data:
//   - daily + monthly spend from getSpendUsd (the page already loads both)
//   - real per-user cap from the `budgets` row
//   - the real global kill switch (mounted as a client island)
//   - the real budget form (mounted as a client island)
//   - real active runtimes (joined from agent_runtimes × projects)
//   - real cost events from getRecentCostEvents
//   - real audit trail rows from the audit_log table
//
// No fake activity graphs, no invented numbers — only the fields the
// ledger and audit_log actually return. The meter fill is a bounded CSS
// transition (one-shot), never an infinite loop animating fake values.

import Link from 'next/link';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { formatCurrency } from '@/lib/currencies';
import {
  auditActorTone,
  costEventTone,
  KILL_SWITCH_COPY,
  meterFill,
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
import { BudgetFormAi } from './BudgetFormAi';
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

const ZONE_FILL_CLASS: Record<SpendColor, string> = {
  mint: styles.meterFillMint!,
  aurora: styles.meterFillAurora!,
  amber: styles.meterFillAmber!,
  rose: styles.meterFillRose!,
};

const SPEND_COLOR_TEXT: Record<SpendColor, string> = {
  mint: 'text-lq-mint',
  aurora: 'text-lq-aurora',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
};

const SPEND_COLOR_DOT: Record<SpendColor, string> = {
  mint: 'bg-lq-mint',
  aurora: 'bg-lq-aurora',
  amber: 'bg-lq-amber',
  rose: 'bg-lq-rose',
};

const ZONE_GLOW_CLASS: Record<SpendColor, string> = {
  mint: '',
  aurora: '',
  amber: styles.zoneGlowAmber!,
  rose: styles.zoneGlowRose!,
};

const EVENT_COLOR_TEXT: Record<SpendColor | 'ink-dim', string> = {
  mint: 'text-lq-mint',
  aurora: 'text-lq-aurora',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
  'ink-dim': 'text-lq-ink-dim',
};

const EVENT_COLOR_BORDER: Record<SpendColor | 'ink-dim', string> = {
  mint: 'border-lq-mint/40',
  aurora: 'border-lq-aurora/40',
  amber: 'border-lq-amber/40',
  rose: 'border-lq-rose/40',
  'ink-dim': 'border-lq-line',
};

export function GovernanceAi({ data, userEmail }: Props) {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-2 py-12 font-ui text-lq-ink">
      {/* Header. */}
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="font-code text-[11px] uppercase tracking-[0.35em] text-lq-aurora">
            Governance · Ceiling + Kill Switch
          </span>
          <span
            aria-hidden
            className="h-px w-12 bg-gradient-to-r from-lq-aurora to-transparent"
          />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-ui text-4xl font-extrabold tracking-[-0.02em] text-lq-ink sm:text-5xl">
            Power, on a leash.
          </h1>
          <div className="flex items-center gap-3 font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            <span>signed in · {userEmail ?? 'user'}</span>
            <form action="/api/auth/sign-out" method="POST">
              <button
                type="submit"
                className="rounded-[10px] border border-lq-line px-3 py-1 transition hover:border-lq-aurora/50 hover:text-lq-ink"
              >
                sign out
              </button>
            </form>
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-lq-ink-dim">
          The ceiling is a per-period dollar cap you set; spend is summed live
          from the ledger and {KILL_SWITCH_COPY.engageCta.toLowerCase()} immediately halts the scheduler
          + refuses every new cost-incurring action until you release it.
        </p>
      </header>

      {/* Kill switch — client island, real POST/DELETE wiring. */}
      <KillSwitchAi
        active={!!data.globalKill && data.globalKill.scope === 'global'}
        reason={data.globalKill?.reason ?? null}
        setBy={data.globalKill?.set_by ?? null}
      />

      {/* Spend meters — daily + monthly, each with its real BudgetForm. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SpendCard
          period="daily"
          panel={data.daily}
          fxNote={data.fxNote}
        />
        <SpendCard
          period="monthly"
          panel={data.monthly}
          fxNote={data.fxNote}
        />
      </div>

      {/* Active runtimes. */}
      <LiquidGlass as="div" className="flex flex-col gap-3 p-6 font-ui">
        <div className="flex items-center justify-between">
          <h2 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
            Active runtimes
          </h2>
          <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            {data.activeRuntimes.length} {data.activeRuntimes.length === 1 ? 'runtime' : 'runtimes'}
          </span>
        </div>
        {data.activeRuntimes.length === 0 ? (
          <p className="text-sm text-lq-ink-dim">
            No active, paused, or errored runtimes. Activated agents will
            appear here with a live indicator and a link to the project.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.activeRuntimes.map((rt) => {
              const vm = runtimeStatusVm(rt.status);
              return (
                <li
                  key={rt.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-lq-line bg-lq-elev-1 px-4 py-3"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <Link
                      href={'/projects/' + rt.project_id}
                      className="font-ui text-sm font-medium text-lq-ink hover:text-lq-aurora hover:underline"
                    >
                      {rt.project_name ?? rt.project_id.slice(0, 8)}
                    </Link>
                    <span className="font-code text-[10px] uppercase tracking-[0.25em] text-lq-ink-faint">
                      {rt.mode} · {rt.schedule_cron} · {rt.run_count} runs
                    </span>
                  </div>
                  <span
                    className={
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] ' +
                      (vm.color === 'ink-dim'
                        ? 'border-lq-line text-lq-ink-dim'
                        : 'border-' + ('lq-' + vm.color) + '/40 text-' + ('lq-' + vm.color))
                    }
                  >
                    {vm.live ? (
                      <span
                        aria-hidden
                        className={
                          'inline-block h-1.5 w-1.5 rounded-full ' +
                          (vm.color === 'ink-dim'
                            ? 'bg-lq-ink-dim'
                            : SPEND_COLOR_DOT[vm.color as SpendColor])
                        }
                      />
                    ) : null}
                    {vm.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </LiquidGlass>

      {/* Recent cost events — real ledger rows. */}
      <LiquidGlass as="div" className="flex flex-col gap-3 p-6 font-ui">
        <div className="flex items-center justify-between">
          <h2 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
            Recent activity
          </h2>
          <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            real ledger · {data.events.length} {data.events.length === 1 ? 'event' : 'events'}
          </span>
        </div>
        {data.events.length === 0 ? (
          <p className="text-sm text-lq-ink-dim">
            No cost events yet. Every LLM call, sandbox test, and runtime run
            lands here automatically with its real model, token counts, and
            USD amount.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-lq-line rounded-[12px] border border-lq-line bg-lq-elev-1">
            {data.events.slice(0, 25).map((e) => {
              const tone = costEventTone(e.kind);
              return (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 font-code text-[12px]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.25em] ' +
                        EVENT_COLOR_BORDER[tone] +
                        ' ' +
                        EVENT_COLOR_TEXT[tone]
                      }
                    >
                      {e.kind}
                    </span>
                    <span className="text-lq-ink">
                      {e.model ?? (e.kind === 'sandbox' || e.kind === 'runtime' ? e.kind : '—')}
                    </span>
                    {e.input_tokens || e.output_tokens ? (
                      <span className="text-lq-ink-dim">
                        · {e.input_tokens} in / {e.output_tokens} out
                      </span>
                    ) : null}
                    {e.compute_ms ? (
                      <span className="text-lq-ink-dim">· {e.compute_ms} ms</span>
                    ) : null}
                    {e.ref ? (
                      <span className="text-lq-ink-faint">· {e.ref}</span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-lq-ink">
                      ${Number(e.amount_usd).toFixed(4)}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.25em] text-lq-ink-faint">
                      {new Date(e.created_at).toLocaleString()}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </LiquidGlass>

      {/* Audit trail — real audit_log rows. */}
      <LiquidGlass as="div" className="flex flex-col gap-3 p-6 font-ui">
        <div className="flex items-center justify-between">
          <h2 className="font-ui text-lg font-bold tracking-tight text-lq-ink">
            Audit trail
          </h2>
          <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            {data.audit.length} {data.audit.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        {data.audit.length === 0 ? (
          <p className="text-sm text-lq-ink-dim">
            The audit trail is empty for the current view.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-lq-line rounded-[12px] border border-lq-line bg-lq-elev-1 font-code text-[12px]">
            {data.audit.slice(0, 40).map((row) => {
              const tone = auditActorTone(row.actor);
              return (
                <li key={row.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-lq-ink">{row.action}</span>
                    <span className="text-[10px] uppercase tracking-[0.25em] text-lq-ink-faint">
                      {new Date(row.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-2 text-[10px] uppercase tracking-[0.25em]">
                    <span className={EVENT_COLOR_TEXT[tone]}>{row.actor}</span>
                    {row.project_id ? (
                      <span className="text-lq-ink-faint">
                        project · {row.project_id.slice(0, 8)}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </LiquidGlass>
    </section>
  );
}

function SpendCard({
  period,
  panel,
  fxNote,
}: {
  period: 'daily' | 'monthly';
  panel: PeriodPanelData;
  fxNote: string;
}) {
  const limitUsd = panel.budget ? Number(panel.budget.limit_usd) : null;
  const vm = spendZone(panel.spendUsd, limitUsd);
  const fillPct = meterFill(panel.spendUsd, limitUsd) * 100;
  const isNonUsd = panel.displayCurrency.toUpperCase() !== 'USD';

  return (
    <LiquidGlass
      as="div"
      className={
        'flex flex-col gap-4 p-6 font-ui ' + ZONE_GLOW_CLASS[vm.color]
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={
              'inline-block h-1.5 w-1.5 rounded-full ' +
              SPEND_COLOR_DOT[vm.color]
            }
          />
          <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
            {period} spend
          </span>
          <span
            className={
              'font-code text-[10px] uppercase tracking-[0.3em] ' +
              SPEND_COLOR_TEXT[vm.color]
            }
          >
            · {vm.label}
          </span>
        </div>
        <p className="font-code text-sm text-lq-ink tabular-nums">
          {formatCurrency(panel.spendDisplay, panel.displayCurrency)}
          {panel.limitDisplay != null ? (
            <span className="text-lq-ink-dim">
              {' '}/ {formatCurrency(panel.limitDisplay, panel.displayCurrency)}
            </span>
          ) : (
            <span className="text-lq-ink-dim"> · no cap</span>
          )}
        </p>
      </div>

      {/* The meter bar — bounded CSS transition fills 0 → real pct on
          mount; the bar sits statically at the real value after that.
          NO infinite loop animating fake spend. */}
      <div className={styles.meterTrack}>
        <div
          className={styles.meterFill + ' ' + ZONE_FILL_CLASS[vm.color]}
          style={{ width: fillPct + '%' }}
          aria-hidden
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-code text-[11px] text-lq-ink-dim">{vm.headroom}</p>
        {isNonUsd ? (
          <p
            className="font-code text-[10px] text-lq-ink-faint"
            title={fxNote}
          >
            {fxNote} · ${panel.spendUsd.toFixed(2)}
            {limitUsd != null ? ' / $' + limitUsd.toFixed(2) : ''} USD
          </p>
        ) : null}
      </div>

      <BudgetFormAi
        period={period}
        current={panel.budget}
        currentDisplayAmount={panel.limitDisplay}
      />
    </LiquidGlass>
  );
}
