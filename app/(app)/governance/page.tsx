// The governance dashboard — spend vs cap, kill switch, recent activity.
//
// All reads use the service-role client but are scoped by the
// authenticated user so RLS + ownership are both enforced.

import Link from 'next/link';
import { GlassPanel } from '@/components/GlassPanel';
import { AuditTrail } from '@/components/governance/AuditTrail';
import { BudgetForm } from '@/components/governance/BudgetForm';
import { CostEventsTable } from '@/components/governance/CostEventsTable';
import { KillSwitchPanel } from '@/components/governance/KillSwitchPanel';
import { SpendMeter } from '@/components/governance/SpendMeter';
import { requireUser } from '@/lib/auth';
import { listBudgets } from '@/lib/engine/governance/budgets';
import { activeKillSwitch } from '@/lib/engine/governance/killswitch';
import {
  getRecentCostEvents,
  getSpendUsd,
} from '@/lib/engine/governance/ledger';
import {
  fromUsdFromSnapshot,
  fxSourceLabel,
  getFxSnapshot,
} from '@/lib/fx';
import { getServerSupabase } from '@/lib/supabase';
import type {
  AgentRuntime,
  AuditLog,
  Budget,
  CostEvent,
  KillSwitch,
  Project,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

interface PeriodPanel {
  // The canonical USD numbers — what the guard actually checks.
  spendUsd: number;
  budget: Budget | null;
  // Display-currency mirror, pre-converted server-side via fx.ts so the
  // client renders without an FX round-trip.
  spendDisplay: number;
  limitDisplay: number | null;
  displayCurrency: string;
}

interface DashboardData {
  daily: PeriodPanel;
  monthly: PeriodPanel;
  globalKill: KillSwitch | null;
  events: CostEvent[];
  audit: AuditLog[];
  activeRuntimes: Array<AgentRuntime & { project_name?: string }>;
  /** Disclaimer text — "approximate · billed in USD" + offline mode hint. */
  fxNote: string;
}

async function loadDashboard(userId: string): Promise<DashboardData> {
  const supabase = getServerSupabase();
  // Fetch FX in parallel with the rest. fxSnapshot is shared across the
  // page so all conversions use one consistent rate set per render.
  const [budgets, dailySpend, monthlySpend, events, globalKill, fxSnapshot] =
    await Promise.all([
      listBudgets(userId, supabase),
      getSpendUsd(userId, 'daily', supabase),
      getSpendUsd(userId, 'monthly', supabase),
      getRecentCostEvents(userId, 50, supabase),
      activeKillSwitch({ userId }, supabase),
      getFxSnapshot(),
    ]);

  const dailyBudget = budgets.find((b) => b.period === 'daily') ?? null;
  const monthlyBudget = budgets.find((b) => b.period === 'monthly') ?? null;

  // Build the display-currency panels. We use the *budget's*
  // display_currency when set (so the user always sees the cap in the
  // currency they typed it in); otherwise USD.
  function buildPanel(
    spendUsd: number,
    budget: Budget | null,
  ): PeriodPanel {
    const ccy = (budget?.display_currency ?? 'USD').toUpperCase();
    const limitUsd = budget ? Number(budget.limit_usd) : null;
    return {
      spendUsd,
      budget,
      spendDisplay: fromUsdFromSnapshot(fxSnapshot, spendUsd, ccy),
      limitDisplay:
        limitUsd != null
          ? fromUsdFromSnapshot(fxSnapshot, limitUsd, ccy)
          : null,
      displayCurrency: ccy,
    };
  }

  // Active runtimes belonging to this user's projects.
  const { data: rtRows } = await supabase
    .from('agent_runtimes')
    .select('*, projects!inner(id, name, user_id)')
    .eq('projects.user_id', userId)
    .in('status', ['active', 'paused', 'errored'])
    .order('updated_at', { ascending: false })
    .limit(20);
  type RuntimeRow = AgentRuntime & {
    projects?: Pick<Project, 'id' | 'name' | 'user_id'>;
  };
  const activeRuntimes: Array<AgentRuntime & { project_name?: string }> = (
    (rtRows ?? []) as RuntimeRow[]
  ).map((r) => ({
    ...r,
    project_name: r.projects?.name,
  }));

  // Audit trail across all projects the user owns + global rows.
  const { data: projects } = await supabase
    .from('projects')
    .select('id')
    .eq('user_id', userId);
  const projectIds = ((projects ?? []) as Array<{ id: string }>).map((p) => p.id);
  let audit: AuditLog[] = [];
  if (projectIds.length === 0) {
    const { data } = await supabase
      .from('audit_log')
      .select('*')
      .is('project_id', null)
      .order('created_at', { ascending: false })
      .limit(40);
    audit = (data ?? []) as AuditLog[];
  } else {
    const { data } = await supabase
      .from('audit_log')
      .select('*')
      .or('project_id.is.null,project_id.in.(' + projectIds.join(',') + ')')
      .order('created_at', { ascending: false })
      .limit(60);
    audit = (data ?? []) as AuditLog[];
  }

  return {
    daily: buildPanel(dailySpend, dailyBudget),
    monthly: buildPanel(monthlySpend, monthlyBudget),
    fxNote: fxSourceLabel(fxSnapshot),
    globalKill,
    events,
    audit,
    activeRuntimes,
  };
}

export default async function GovernancePage() {
  const user = await requireUser();
  const data = await loadDashboard(user.id);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 py-12">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            governance · control room
          </p>
          <h1 className="mt-2 text-3xl font-medium text-forge-text">
            Spend, safety, and the kill switch
          </h1>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          <span>signed in · {user.email ?? user.id.slice(0, 8)}</span>
          <form action="/api/auth/sign-out" method="POST">
            <button
              type="submit"
              className="rounded-lg border border-white/10 px-3 py-1 transition hover:border-white/30 hover:text-forge-text"
            >
              sign out
            </button>
          </form>
        </div>
      </header>

      <KillSwitchPanel
        active={!!data.globalKill && data.globalKill.scope === 'global'}
        reason={data.globalKill?.reason ?? null}
        setBy={data.globalKill?.set_by ?? null}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <GlassPanel>
          <div className="flex flex-col gap-3">
            <SpendMeter
              period="daily"
              spendUsd={data.daily.spendUsd}
              budget={data.daily.budget}
              spendDisplay={data.daily.spendDisplay}
              limitDisplay={data.daily.limitDisplay}
              displayCurrency={data.daily.displayCurrency}
              fxNote={data.fxNote}
            />
            <BudgetForm
              period="daily"
              current={data.daily.budget}
              currentDisplayAmount={data.daily.limitDisplay}
            />
          </div>
        </GlassPanel>
        <GlassPanel>
          <div className="flex flex-col gap-3">
            <SpendMeter
              period="monthly"
              spendUsd={data.monthly.spendUsd}
              budget={data.monthly.budget}
              spendDisplay={data.monthly.spendDisplay}
              limitDisplay={data.monthly.limitDisplay}
              displayCurrency={data.monthly.displayCurrency}
              fxNote={data.fxNote}
            />
            <BudgetForm
              period="monthly"
              current={data.monthly.budget}
              currentDisplayAmount={data.monthly.limitDisplay}
            />
          </div>
        </GlassPanel>
      </div>

      <GlassPanel>
        <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
          active runtimes ({data.activeRuntimes.length})
        </h2>
        {data.activeRuntimes.length === 0 ? (
          <p className="mt-3 text-sm text-forge-dim">
            No active or paused runtimes. Activated agents will appear here
            with quick controls.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {data.activeRuntimes.map((rt) => (
              <li
                key={rt.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 p-3"
              >
                <div className="flex flex-col gap-0.5">
                  <Link
                    href={'/projects/' + rt.project_id}
                    className="font-mono text-sm text-forge-text hover:text-forge-amber hover:underline"
                  >
                    {rt.project_name ?? rt.project_id.slice(0, 8)}
                  </Link>
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim">
                    {rt.mode} · {rt.schedule_cron} · {rt.run_count} runs
                  </span>
                </div>
                <span
                  className={
                    'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] ' +
                    (rt.status === 'active'
                      ? 'border-forge-amber/50 text-forge-amber'
                      : rt.status === 'errored'
                        ? 'border-rose-400/50 text-rose-300'
                        : 'border-white/15 text-forge-dim')
                  }
                >
                  {rt.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </GlassPanel>

      <GlassPanel>
        <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
          recent cost events
        </h2>
        <div className="mt-3 overflow-x-auto">
          <CostEventsTable events={data.events} />
        </div>
      </GlassPanel>

      <GlassPanel>
        <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
          audit trail
        </h2>
        <div className="mt-3">
          <AuditTrail rows={data.audit} />
        </div>
      </GlassPanel>
    </section>
  );
}
