// Presentational render of a ProvisioningPlan. Same visual rhythm as
// the SoftwareBuildPlanView so the project page reads consistently
// across kinds. Pure render — no fetches, no state.

import type {
  ProvisioningPlan,
  ProvisioningStep,
} from '@/lib/engine/infra/planner/schema';
import {
  LAYERS,
  moduleById,
  type LayerId,
} from '@/lib/engine/infra/planner/modules';

const LAYER_TONE: Record<LayerId, string> = {
  network:       'border-rose-400/40 text-rose-300',
  data:          'border-forge-amber/40 text-forge-amber',
  compute:       'border-forge-cyan/40 text-forge-cyan',
  observability: 'border-emerald-400/40 text-emerald-300',
};

export function ProvisioningPlanView({ plan }: { plan: ProvisioningPlan }) {
  // Group steps by layer for the four-layer view.
  const byLayer = new Map<LayerId, ProvisioningStep[]>();
  for (const l of LAYERS) byLayer.set(l.id, []);
  for (const s of plan.steps) {
    const bucket = byLayer.get(s.layer as LayerId);
    if (bucket) bucket.push(s);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            infrastructure provisioning plan
          </p>
          <h2 className="mt-1 text-2xl font-medium text-forge-text">
            {plan.steps.length} steps · 4 layers
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-forge-dim">
            catalog: {plan.catalog_version} · vetted modules only · no raw provider / IAM / network config
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
        const steps = byLayer.get(l.id) ?? [];
        return (
          <Section
            key={l.id}
            title={l.label + ' (' + steps.length + ')'}
          >
            {steps.length === 0 ? (
              <p className="text-xs text-forge-dim">no steps in this layer.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {steps.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-lg border border-white/10 bg-black/30 p-3"
                  >
                    <StepCard step={s} />
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

function StepCard({ step }: { step: ProvisioningStep }) {
  const mod = moduleById(step.module);
  const configKeys = Object.keys(step.config ?? {});

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-xs text-forge-amber">{step.id}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          module · {step.module}
          {step.resource_id ? ' · ' + step.resource_id : ''}
        </p>
      </div>

      <p className="text-sm leading-relaxed text-forge-text/90">{step.description}</p>

      <p className="font-mono text-[10px] text-forge-dim">
        composes the vetted <span className="text-forge-cyan">{mod.label}</span> module
      </p>

      {step.depends_on.length > 0 ? (
        <p className="font-mono text-[10px] text-forge-dim">
          depends on: {step.depends_on.join(', ')}
        </p>
      ) : null}

      {configKeys.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {configKeys.map((k) => (
            <li
              key={k}
              className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] text-forge-text/90"
            >
              {k}
              <span className="ml-1 text-forge-dim">
                : {formatConfigValue(step.config[k])}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {step.secure_defaults.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1">
          <li className="font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300/80">
            secure defaults
          </li>
          {step.secure_defaults.map((d) => (
            <li
              key={d}
              className="rounded border border-emerald-400/20 bg-emerald-500/5 px-2 py-1 font-mono text-[10px] text-emerald-200/90"
            >
              · {d}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatConfigValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(String).join(', ') + ']';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '?';
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
