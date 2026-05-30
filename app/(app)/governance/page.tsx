// /governance — MIGRATED to AI-futuristic. The page stays the data source:
// it loads daily + monthly spend, real budgets, the global kill-switch row,
// real active runtimes, real recent cost events, and the real audit trail —
// then hands them to <GovernanceAi /> for presentation. All real actions
// (kill switch POST/DELETE, budget PUT/DELETE) are preserved through the
// client islands that GovernanceAi mounts.
//
// All reads use the service-role client but are scoped by the authenticated
// user so RLS + ownership are both enforced.

import {
  GovernanceAi,
  type GovernanceData,
  type PeriodPanelData,
} from '@/components/governance-ai/GovernanceAi';
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
  Project,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

async function loadDashboard(userId: string): Promise<GovernanceData> {
  const supabase = getServerSupabase();
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

  function buildPanel(spendUsd: number, budget: Budget | null): PeriodPanelData {
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

  // Active runtimes (real) joined with project names.
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

  // Audit trail (real) across the user's projects + global rows.
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
  return <GovernanceAi data={data} userEmail={user.email ?? null} />;
}
