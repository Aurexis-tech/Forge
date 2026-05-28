// Presentational render of an AgentSpec. Used by both the review panel and
// the confirmed panel — keep it pure so it stays trivially shareable.
//
// SPEC FIDELITY: takes an optional `confidence` map. When present,
// each top-level field renders a small ConfidenceBadge alongside
// its label. When absent (historical specs / confirmed-panel reuse
// without confidence), rendering matches today's behaviour exactly
// — zero regression.

import type { AgentSpec } from '@/lib/engine/spec/schema';
import { ConfidenceBadge } from './ConfidenceBadge';
import { levelForField, type SpecConfidence } from './confidence-display';

const RISK_TONE: Record<AgentSpec['risk'], string> = {
  low: 'text-emerald-300 border-emerald-400/40',
  medium: 'text-amber-300 border-amber-400/40',
  high: 'text-rose-300 border-rose-400/50',
};

export interface SpecViewProps {
  spec: AgentSpec;
  /** Optional per-field confidence map. Absence = no badges rendered. */
  confidence?: SpecConfidence | null;
}

export function SpecView({ spec, confidence }: SpecViewProps) {
  const lvl = (field: string) => levelForField(confidence, field);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            agent spec
          </p>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-medium text-forge-text">
            {spec.name}
            <ConfidenceBadge level={lvl('name')} compact />
          </h2>
          <p className="mt-2 flex flex-wrap items-center gap-2 max-w-xl text-sm text-forge-dim">
            {spec.goal}
            <ConfidenceBadge level={lvl('goal')} compact />
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Pill className={RISK_TONE[spec.risk]}>risk · {spec.risk}</Pill>
          <Pill>
            confidence · {Math.round(spec.confidence * 100)}%
          </Pill>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KV label="trigger" value={spec.trigger} level={lvl('trigger')} />
        <KV label="runtime" value={spec.runtime} level={lvl('runtime')} />
      </div>

      <Section title="description" level={lvl('description')}>
        <p className="text-sm leading-relaxed text-forge-text/90">
          {spec.description}
        </p>
      </Section>

      <Section title="inputs" level={lvl('inputs')}>
        <NamedList items={spec.inputs} emptyLabel="No declared inputs." />
      </Section>

      <Section title="capabilities" level={lvl('capabilities')}>
        {spec.capabilities.length === 0 ? (
          <p className="text-sm text-forge-dim">No capabilities declared.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {spec.capabilities.map((c, i) => (
              <li
                key={`${c.tool}-${i}`}
                className="rounded-lg border border-white/10 bg-black/30 p-3"
              >
                <code className="font-mono text-xs text-forge-amber">
                  {c.tool}
                </code>
                <p className="mt-1 text-sm text-forge-text/90">{c.why}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="outputs" level={lvl('outputs')}>
        <NamedList items={spec.outputs} emptyLabel="No declared outputs." />
      </Section>

      <Section title="constraints" level={lvl('constraints')}>
        <BulletList items={spec.constraints} emptyLabel="No constraints declared." />
      </Section>

      <Section title="success criteria" level={lvl('success_criteria')}>
        <BulletList
          items={spec.success_criteria}
          emptyLabel="No success criteria declared."
        />
      </Section>
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
  level,
}: {
  title: string;
  children: React.ReactNode;
  level?: ReturnType<typeof levelForField>;
}) {
  return (
    <section>
      <h3 className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
        {title}
        <ConfidenceBadge level={level} />
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function KV({
  label,
  value,
  level,
}: {
  label: string;
  value: string;
  level?: ReturnType<typeof levelForField>;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <p className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        {label}
        <ConfidenceBadge level={level} compact />
      </p>
      <p className="mt-1 font-mono text-sm text-forge-text">{value}</p>
    </div>
  );
}

function NamedList({
  items,
  emptyLabel,
}: {
  items: { name: string; description: string }[];
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-forge-dim">{emptyLabel}</p>;
  }
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {items.map((item, i) => (
        <li
          key={`${item.name}-${i}`}
          className="rounded-lg border border-white/10 bg-black/30 p-3"
        >
          <p className="font-mono text-xs text-forge-cyan">{item.name}</p>
          <p className="mt-1 text-sm text-forge-text/90">{item.description}</p>
        </li>
      ))}
    </ul>
  );
}

function BulletList({
  items,
  emptyLabel,
}: {
  items: string[];
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-forge-dim">{emptyLabel}</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5 text-sm text-forge-text/90">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-forge-amber" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
