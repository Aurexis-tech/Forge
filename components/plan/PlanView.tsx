// Pure presentational render of a BuildPlan. Used by both the review panel
// (client, with controls) and the approved panel (server, locked).

import type { BuildPlan, PlanTool } from '@/lib/engine/planner/schema';
import { TaskGraph } from './TaskGraph';

const STATUS_TONE: Record<PlanTool['status'], string> = {
  supported: 'border-emerald-400/40 text-emerald-300 bg-emerald-400/5',
  needs_key: 'border-amber-400/50 text-amber-200 bg-amber-400/5',
  unsupported: 'border-rose-400/50 text-rose-300 bg-rose-400/5',
};

const RISK_TONE: Record<BuildPlan['estimate']['risk'], string> = {
  low: 'text-emerald-300 border-emerald-400/40',
  medium: 'text-amber-300 border-amber-400/40',
  high: 'text-rose-300 border-rose-400/50',
};

export function PlanView({ plan }: { plan: BuildPlan }) {
  return (
    <div className="flex flex-col gap-7">
      {plan.warnings.length > 0 ? (
        <Warnings warnings={plan.warnings} />
      ) : null}

      <Header plan={plan} />

      <Section title="target">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <KV label="framework" value={plan.target.framework} />
          <KV label="hosting" value={plan.target.hosting} />
          <KV label="entrypoint" value={plan.target.entrypoint} />
        </div>
      </Section>

      <Section title="trigger implementation">
        <p className="text-sm leading-relaxed text-forge-text/90">
          {plan.trigger_impl}
        </p>
      </Section>

      <Section title="tools">
        <ToolsList tools={plan.tools} />
      </Section>

      <Section title="planned files">
        <FilesList files={plan.files} />
      </Section>

      <Section title="environment required">
        <EnvList env={plan.env_required} />
      </Section>

      <Section title="build task graph">
        <TaskGraph tasks={plan.tasks} />
      </Section>

      <Section title="estimate">
        <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-black/30 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill className={RISK_TONE[plan.estimate.risk]}>
              build risk · {plan.estimate.risk}
            </Pill>
            <Pill className={RISK_TONE[plan.estimate.complexity]}>
              complexity · {plan.estimate.complexity}
            </Pill>
          </div>
          <p className="text-sm leading-relaxed text-forge-text/90">
            {plan.estimate.notes}
          </p>
        </div>
      </Section>
    </div>
  );
}

function Header({ plan }: { plan: BuildPlan }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
          build plan
        </p>
        <h2 className="mt-1 text-2xl font-medium text-forge-text">
          <code className="font-mono text-forge-amber">{plan.scaffold}</code>
        </h2>
      </div>
      <Pill>runtime · {plan.runtime_impl}</Pill>
    </header>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-xl border border-amber-400/50 bg-amber-500/[0.07] p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-amber-300">
        warnings · review before approving
      </p>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm text-amber-100/90">
        {warnings.map((w, i) => (
          <li key={i} className="flex gap-2">
            <span
              aria-hidden
              className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-amber-300"
            />
            <span>{w}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolsList({ tools }: { tools: PlanTool[] }) {
  if (tools.length === 0) {
    return (
      <p className="text-sm text-forge-dim">No tools requested by the spec.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {tools.map((t, i) => (
        <li
          key={`${t.requested}-${i}`}
          className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/30 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <code className="font-mono text-sm text-forge-amber">
                {t.requested}
              </code>
              {t.registry_id && t.registry_id !== t.requested ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim">
                  → {t.registry_id}
                </span>
              ) : null}
            </div>
            <Pill className={STATUS_TONE[t.status]}>{t.status.replace('_', ' ')}</Pill>
          </div>
          {t.env_keys.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-forge-dim">
                env
              </span>
              {t.env_keys.map((k) => (
                <code
                  key={k}
                  className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] text-forge-text/80"
                >
                  {k}
                </code>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FilesList({ files }: { files: BuildPlan['files'] }) {
  if (files.length === 0) {
    return <p className="text-sm text-forge-dim">No files planned.</p>;
  }
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {files.map((f, i) => (
        <li
          key={`${f.path}-${i}`}
          className="rounded-lg border border-white/10 bg-black/30 p-3"
        >
          <code className="font-mono text-xs text-forge-cyan">{f.path}</code>
          <p className="mt-1 text-sm text-forge-text/90">{f.purpose}</p>
        </li>
      ))}
    </ul>
  );
}

function EnvList({ env }: { env: BuildPlan['env_required'] }) {
  if (env.length === 0) {
    return (
      <p className="text-sm text-forge-dim">No additional env vars required.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {env.map((e, i) => (
        <li
          key={`${e.key}-${i}`}
          className="flex flex-col gap-1 rounded-lg border border-white/10 bg-black/30 p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <code className="font-mono text-sm text-forge-amber">{e.key}</code>
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              {e.secret ? 'secret' : 'config'}
            </span>
          </div>
          <p className="text-sm text-forge-text/90">{e.why}</p>
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        {label}
      </p>
      <p className="mt-1 font-mono text-sm text-forge-text">{value}</p>
    </div>
  );
}

function Pill({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={
        'rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] ' +
        (className || 'border-white/15 text-forge-dim')
      }
    >
      {children}
    </span>
  );
}
