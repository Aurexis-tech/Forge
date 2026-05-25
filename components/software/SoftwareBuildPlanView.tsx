// Presentational render of a SoftwareBuildPlan. Same visual rhythm
// as the OrchestrationPlanView so the project page reads consistently
// across kinds. Pure render — no fetches, no state.

import type {
  SoftwareBuildPlan,
  SoftwareTask,
} from '@/lib/engine/software/planner/schema';
import { LAYERS, type LayerId } from '@/lib/engine/software/planner/template';

const LAYER_TONE: Record<LayerId, string> = {
  schema: 'border-forge-amber/40 text-forge-amber',
  api:    'border-forge-cyan/40 text-forge-cyan',
  ui:     'border-emerald-400/40 text-emerald-300',
  auth:   'border-rose-400/40 text-rose-300',
};

export function SoftwareBuildPlanView({ plan }: { plan: SoftwareBuildPlan }) {
  // Group tasks by layer for the four-layer view.
  const byLayer = new Map<LayerId, SoftwareTask[]>();
  for (const l of LAYERS) byLayer.set(l.id, []);
  for (const t of plan.tasks) {
    const bucket = byLayer.get(t.layer as LayerId);
    if (bucket) bucket.push(t);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            software build plan
          </p>
          <h2 className="mt-1 text-2xl font-medium text-forge-text">
            {plan.tasks.length} tasks · 4 layers
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-forge-dim">
            template: {plan.template_id}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {LAYERS.map((l) => (
            <Pill key={l.id} className={LAYER_TONE[l.id]}>
              {l.label} · {byLayer.get(l.id)?.length ?? 0}
            </Pill>
          ))}
        </div>
      </header>

      <Section title="execution order">
        <ol className="flex flex-wrap items-center gap-2">
          {plan.execution_order.map((id, i) => (
            <li
              key={id}
              className="flex items-center gap-2 font-mono text-[11px] text-forge-text/90"
            >
              <span className="rounded-full border border-forge-amber/40 px-2 py-0.5 text-forge-amber">
                {i + 1}
              </span>
              <span className="text-forge-cyan">{id}</span>
              {i < plan.execution_order.length - 1 ? (
                <span aria-hidden className="text-forge-dim">→</span>
              ) : null}
            </li>
          ))}
        </ol>
      </Section>

      {LAYERS.map((l) => {
        const tasks = byLayer.get(l.id) ?? [];
        return (
          <Section
            key={l.id}
            title={l.label + ' (' + tasks.length + ')'}
          >
            {tasks.length === 0 ? (
              <p className="text-xs text-forge-dim">no tasks in this layer.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {tasks.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-lg border border-white/10 bg-black/30 p-3"
                  >
                    <TaskCard task={t} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        );
      })}

      {plan.warnings.length > 0 ? (
        <Section title={'warnings (' + plan.warnings.length + ')'}>
          <ul className="flex flex-col gap-1.5">
            {plan.warnings.map((w, i) => (
              <li
                key={i}
                className="rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-100"
              >
                {w}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function TaskCard({ task }: { task: SoftwareTask }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-xs text-forge-amber">{task.id}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          slot · {task.slot.kind}
          {task.slot.target ? ' · ' + task.slot.target : ''}
        </p>
      </div>

      <p className="text-sm leading-relaxed text-forge-text/90">{task.description}</p>

      {task.depends_on.length > 0 ? (
        <p className="font-mono text-[10px] text-forge-dim">
          depends on: {task.depends_on.join(', ')}
        </p>
      ) : null}

      {task.files.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {task.files.map((f) => (
            <li
              key={f}
              className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] text-forge-text/80"
            >
              {f}
            </li>
          ))}
        </ul>
      ) : null}
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
