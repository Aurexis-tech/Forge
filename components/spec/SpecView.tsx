// Presentational render of an AgentSpec. Used by both the review panel and
// the confirmed panel — keep it pure so it stays trivially shareable.

import type { AgentSpec } from '@/lib/engine/spec/schema';

const RISK_TONE: Record<AgentSpec['risk'], string> = {
  low: 'text-emerald-300 border-emerald-400/40',
  medium: 'text-amber-300 border-amber-400/40',
  high: 'text-rose-300 border-rose-400/50',
};

export function SpecView({ spec }: { spec: AgentSpec }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            agent spec
          </p>
          <h2 className="mt-1 text-2xl font-medium text-forge-text">
            {spec.name}
          </h2>
          <p className="mt-2 max-w-xl text-sm text-forge-dim">{spec.goal}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Pill className={RISK_TONE[spec.risk]}>risk · {spec.risk}</Pill>
          <Pill>
            confidence · {Math.round(spec.confidence * 100)}%
          </Pill>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KV label="trigger" value={spec.trigger} />
        <KV label="runtime" value={spec.runtime} />
      </div>

      <Section title="description">
        <p className="text-sm leading-relaxed text-forge-text/90">
          {spec.description}
        </p>
      </Section>

      <Section title="inputs">
        <NamedList items={spec.inputs} emptyLabel="No declared inputs." />
      </Section>

      <Section title="capabilities">
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

      <Section title="outputs">
        <NamedList items={spec.outputs} emptyLabel="No declared outputs." />
      </Section>

      <Section title="constraints">
        <BulletList items={spec.constraints} emptyLabel="No constraints declared." />
      </Section>

      <Section title="success criteria">
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
