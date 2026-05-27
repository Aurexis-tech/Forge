// Read-only view of the Phase 4-5a real `terraform plan` diff. The
// component receives ONLY a sanitised PublicInfraPlan from the
// persistence layer — the plan_diff blob has already been scrubbed
// of secret-shaped strings at the CloudProvider boundary.
//
// The view groups planned resources by ACTION (create / change /
// REPLACE / destroy), surfaces the live ceiling re-check verdict,
// and prominently warns about destructive actions in red. The
// confirm gate is a separate component (InfraConfirmPlanFlow) so
// this view can also be used in read-only post-confirm contexts.

import { GlassPanel } from '@/components/GlassPanel';
import type { PublicInfraPlan } from '@/lib/engine/infra/cloud/persistence';
import type {
  InfraPlanDiff,
  PlannedResource,
} from '@/lib/engine/infra/cloud/provider';

interface Props {
  plan: PublicInfraPlan;
}

export function InfraPlanView({ plan }: Props) {
  const diff = plan.plan_diff;
  const verdict = plan.ceiling_verdict;
  const isOver = verdict === 'over_budget';
  const isNoBudget = verdict === 'no_budget_set';

  return (
    <GlassPanel
      className={
        isOver
          ? 'border-rose-400/50 shadow-amber'
          : plan.destructive
            ? 'border-forge-amber/60 shadow-amber'
            : 'border-emerald-400/40 shadow-amber'
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={
                'inline-block h-2 w-2 rounded-full ' +
                (isOver
                  ? 'bg-rose-400 shadow-amber'
                  : plan.destructive
                    ? 'bg-forge-amber shadow-amber'
                    : 'bg-emerald-400 shadow-amber')
              }
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              infrastructure · live plan (terraform)
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            phase 4-5a · read-only · nothing applied
          </p>
        </div>

        {/* --- Ceiling re-check verdict ---------------------------- */}
        <CeilingBanner plan={plan} />

        {/* --- Top-line action counts ------------------------------ */}
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
          <ActionStat label="create" value={diff.create_count} tone="green" />
          <ActionStat label="change" value={diff.change_count} tone="amber" />
          <ActionStat
            label="replace"
            value={diff.replace_count}
            tone="amber"
          />
          <ActionStat label="DESTROY" value={diff.destroy_count} tone="red" />
        </div>

        {/* --- Destructive callout --------------------------------- */}
        {plan.destructive ? (
          <div className="rounded-lg border border-rose-400/50 bg-rose-500/10 p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
              destructive plan · changes existing resources
            </p>
            <p className="mt-2 text-sm text-rose-100">
              This plan will modify or remove existing resources. A click is
              not enough — the confirm gate below requires you to type the
              exact phrase{' '}
              {plan.typed_phrase_required ? (
                <code className="rounded bg-black/40 px-1 text-rose-200">
                  {plan.typed_phrase_required}
                </code>
              ) : null}
              .
            </p>
          </div>
        ) : (
          <p className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
            pure-create plan · no existing resource will be changed or
            destroyed
          </p>
        )}

        {/* --- Resources by action group --------------------------- */}
        <div className="flex flex-col gap-3">
          <ActionGroup
            label="CREATE"
            tone="green"
            resources={diff.resources.filter((r) => r.action === 'create')}
          />
          <ActionGroup
            label="CHANGE"
            tone="amber"
            resources={diff.resources.filter((r) => r.action === 'change')}
          />
          <ActionGroup
            label="REPLACE"
            tone="amber"
            resources={diff.resources.filter((r) => r.action === 'replace')}
          />
          <ActionGroup
            label="DESTROY"
            tone="red"
            resources={diff.resources.filter((r) => r.action === 'destroy')}
          />
        </div>

        <p className="font-mono text-[10px] text-forge-dim/80">
          terraform {diff.terraform_version} · plan generated against live
          cloud state (read-only) · zero cloud writes
        </p>

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          locked · apply (the real-cloud write) lands next, behind P4-5b
        </p>
      </div>
    </GlassPanel>
  );
}

function CeilingBanner({ plan }: { plan: PublicInfraPlan }) {
  if (plan.ceiling_verdict === 'over_budget') {
    return (
      <div className="rounded-lg border border-rose-400/50 bg-rose-500/10 p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-rose-300">
          over budget · gate blocked
        </p>
        <p className="mt-2 text-sm text-rose-100">{plan.ceiling_message}</p>
      </div>
    );
  }
  if (plan.ceiling_verdict === 'no_budget_set') {
    return (
      <div className="rounded-lg border border-forge-amber/40 bg-forge-amber/10 p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
          no hard-cap budget set
        </p>
        <p className="mt-2 text-sm text-forge-text/90">
          {plan.ceiling_message}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-emerald-400/50 bg-emerald-500/10 p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
        within budget · re-checked against the real plan
      </p>
      <p className="mt-2 text-sm text-emerald-100">{plan.ceiling_message}</p>
    </div>
  );
}

function ActionStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'green' | 'amber' | 'red';
}) {
  const tones = {
    green: { ring: 'border-emerald-400/30', text: 'text-emerald-300' },
    amber: { ring: 'border-forge-amber/30', text: 'text-forge-amber' },
    red: { ring: 'border-rose-400/40', text: 'text-rose-300' },
  } as const;
  const t = tones[tone];
  return (
    <div className={'rounded-lg border bg-black/30 px-3 py-2 ' + t.ring}>
      <p className="text-forge-dim">{label}</p>
      <p className={'mt-1 text-base ' + t.text}>{value}</p>
    </div>
  );
}

function ActionGroup({
  label,
  tone,
  resources,
}: {
  label: string;
  tone: 'green' | 'amber' | 'red';
  resources: ReadonlyArray<PlannedResource>;
}) {
  if (resources.length === 0) return null;
  const tones = {
    green: 'border-emerald-400/30 text-emerald-300',
    amber: 'border-forge-amber/40 text-forge-amber',
    red: 'border-rose-400/40 text-rose-300',
  } as const;
  return (
    <div className={'rounded-lg border bg-black/30 p-3 ' + tones[tone]}>
      <p className="font-mono text-[10px] uppercase tracking-[0.3em]">
        {label} · {resources.length}
      </p>
      <ul className="mt-2 flex flex-col gap-1 font-mono text-[11px] text-forge-text/90">
        {resources.map((r) => (
          <li
            key={r.address}
            className="flex flex-wrap items-baseline justify-between gap-2"
          >
            <span className="break-all">
              {r.address}
              <span className="ml-2 text-forge-dim">{r.type}</span>
            </span>
            {r.module ? (
              <span className="text-forge-dim">module: {r.module}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Re-export the InfraPlanDiff type to make it ergonomic for the page-
// router to type-check the prop shape without reaching into
// lib/engine/infra/cloud/provider.
export type { InfraPlanDiff };
