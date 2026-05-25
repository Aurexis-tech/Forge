// Presentational render of a SystemSpec (Phase 2). Same visual rhythm
// as the AgentSpec SpecView so /projects/[id] feels consistent whether
// the user landed on an agent or a system project.

import type {
  CoordinationPattern,
  SystemSpec,
} from '@/lib/engine/system/spec';

const PATTERN_LABEL: Record<CoordinationPattern, string> = {
  pipeline: 'pipeline · A → B → C',
  fan_out_in: 'fan-out / fan-in · 1 → N → 1',
  dag: 'dag · arbitrary directed graph',
};

export function SystemSpecView({ spec }: { spec: SystemSpec }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            system spec
          </p>
          <h2 className="mt-1 text-2xl font-medium text-forge-text">
            {spec.sub_agents.length} sub-agents · {spec.coordination.pattern}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-forge-dim">{spec.goal}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Pill>max steps · {spec.max_steps}</Pill>
          <Pill>triggers · {spec.triggers.join(', ')}</Pill>
        </div>
      </header>

      <Section title="coordination">
        <div className="rounded-lg border border-white/10 bg-black/30 p-3">
          <p className="font-mono text-xs text-forge-amber">
            {PATTERN_LABEL[spec.coordination.pattern]}
          </p>
          {spec.coordination.edges && spec.coordination.edges.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {spec.coordination.edges.map((e, i) => (
                <li
                  key={i}
                  className="font-mono text-[11px] text-forge-text/90"
                >
                  <span className="text-forge-cyan">{e.from}</span>
                  <span className="mx-2 text-forge-dim">→</span>
                  <span className="text-forge-cyan">{e.to}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-forge-dim">
              {spec.coordination.pattern === 'pipeline'
                ? 'edges implied by sub_agents declaration order.'
                : 'no edges declared.'}
            </p>
          )}
        </div>
      </Section>

      <Section title={'sub-agents (' + spec.sub_agents.length + ')'}>
        <ul className="flex flex-col gap-3">
          {spec.sub_agents.map((a) => (
            <li
              key={a.id}
              className="rounded-lg border border-white/10 bg-black/30 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-xs text-forge-amber">
                  {a.id}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                  role · {a.role}
                </p>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-forge-text/90">
                {a.description}
              </p>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <BulletBlock label="inputs" items={a.inputs} />
                <BulletBlock label="outputs" items={a.outputs} />
              </div>

              {a.tools && a.tools.length > 0 ? (
                <div className="mt-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                    tools
                  </p>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {a.tools.map((t) => (
                      <li
                        key={t}
                        className="rounded-full border border-forge-cyan/30 px-2 py-0.5 font-mono text-[10px] text-forge-cyan"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
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

function BulletBlock({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        {label}
      </p>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-forge-dim">—</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1 text-sm text-forge-text/90">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2">
              <span
                aria-hidden
                className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-forge-amber"
              />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
