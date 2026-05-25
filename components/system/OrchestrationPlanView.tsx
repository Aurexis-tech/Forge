// Presentational render of an OrchestrationPlan. Used by both the
// review panel and the approved panel — keep it pure.

import type {
  OrchestrationPlan,
  OrchestrationNode,
} from '@/lib/engine/system/planner/schema';
import type { CoordinationPattern } from '@/lib/engine/system/spec';

const PATTERN_LABEL: Record<CoordinationPattern, string> = {
  pipeline: 'pipeline · A → B → C',
  fan_out_in: 'fan-out / fan-in · 1 → N → 1',
  dag: 'dag · arbitrary directed graph',
};

const TOOL_STATUS_TONE: Record<string, string> = {
  supported: 'border-emerald-400/40 text-emerald-200',
  needs_key: 'border-amber-400/40 text-amber-200',
  unsupported: 'border-rose-400/40 text-rose-200',
};

export function OrchestrationPlanView({ plan }: { plan: OrchestrationPlan }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            orchestration plan
          </p>
          <h2 className="mt-1 text-2xl font-medium text-forge-text">
            {plan.nodes.length} nodes · {plan.pattern}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-forge-dim">{plan.goal}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Pill>{PATTERN_LABEL[plan.pattern]}</Pill>
          <Pill>max steps · {plan.max_steps}</Pill>
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

      <Section title={'nodes (' + plan.nodes.length + ')'}>
        <ul className="flex flex-col gap-3">
          {plan.nodes.map((n) => (
            <li
              key={n.id}
              className="rounded-lg border border-white/10 bg-black/30 p-3"
            >
              <NodeCard node={n} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title={'edges (' + plan.edges.length + ')'}>
        {plan.edges.length === 0 ? (
          <p className="text-xs text-forge-dim">
            no edges declared — only valid for single-node plans, which the
            planner doesn't emit. If you see this, something is wrong.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {plan.edges.map((e, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-forge-text/90"
              >
                <span className="text-forge-cyan">{e.from}</span>
                <span aria-hidden className="text-forge-dim">→</span>
                <span className="text-forge-cyan">{e.to}</span>
                <span className="text-forge-dim">·</span>
                <span className="text-forge-text/80">{e.payload}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

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

function NodeCard({ node }: { node: OrchestrationNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-xs text-forge-amber">{node.id}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          role · {node.role}
        </p>
      </div>

      <p className="text-sm leading-relaxed text-forge-text/90">{node.task}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Block label="inputs">
          {node.inputs.length === 0 ? (
            <p className="text-xs text-forge-dim">—</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-forge-text/90">
              {node.inputs.map((h, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[10px] text-forge-dim">
                    from
                  </span>
                  <span className="font-mono text-xs text-forge-cyan">
                    {h.from ?? 'external'}
                  </span>
                  <span aria-hidden className="text-forge-dim">→</span>
                  <span className="text-forge-text/80">{h.output}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block label="outputs">
          {node.outputs.length === 0 ? (
            <p className="text-xs text-forge-dim">—</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-forge-text/90">
              {node.outputs.map((o, i) => (
                <li key={i} className="flex gap-2">
                  <span
                    aria-hidden
                    className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-forge-amber"
                  />
                  <span>{o}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </div>

      {node.suggested_tools.length > 0 ? (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            suggested tools
          </p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {node.suggested_tools.map((t, i) => (
              <li
                key={i}
                className={
                  'rounded-full border px-2 py-0.5 font-mono text-[10px] ' +
                  (TOOL_STATUS_TONE[t.status] ?? 'border-white/15 text-forge-dim')
                }
                title={
                  t.status === 'supported'
                    ? 'available in the registry'
                    : t.status === 'needs_key'
                      ? 'available but requires env keys: ' + (t.env_keys.join(', ') || 'none listed')
                      : 'not supported by the current registry'
                }
              >
                {t.requested}
                {t.status === 'needs_key' ? ' · needs key' : ''}
                {t.status === 'unsupported' ? ' · unsupported' : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
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

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        {label}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  );
}
