// Presentational render of an InfraSpec. Same visual rhythm as the
// AgentSpec / SystemSpec / SoftwareSpec views so /projects/[id] feels
// consistent whether the user landed on an agent, system, software,
// or infrastructure project.

import type { InfraSpec } from '@/lib/engine/infra/spec';

export function InfraSpecView({ spec }: { spec: InfraSpec }) {
  const { goal, resources, topology, region, lifecycle } = spec;

  const byId = new Map(resources.map((r) => [r.id, r]));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            infrastructure spec
          </p>
          <h2 className="mt-1 text-2xl font-medium text-forge-text">
            {resources.length} resources · {topology.length} edges
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-forge-dim">{goal}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Pill
            className={
              lifecycle === 'persistent'
                ? 'border-forge-amber/40 text-forge-amber'
                : ''
            }
          >
            {lifecycle}
          </Pill>
          {region ? <Pill>region · {region}</Pill> : <Pill>region · any</Pill>}
        </div>
      </header>

      <Section title={'resources (' + resources.length + ')'}>
        <ul className="flex flex-col gap-3">
          {resources.map((r) => {
            const configKeys = Object.keys(r.config ?? {});
            return (
              <li
                key={r.id}
                className="rounded-lg border border-white/10 bg-black/30 p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-mono text-xs text-forge-amber">{r.id}</p>
                  <p className="rounded-full border border-forge-cyan/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan">
                    {r.type}
                  </p>
                </div>
                {configKeys.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {configKeys.map((k) => (
                      <li
                        key={k}
                        className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] text-forge-text/90"
                      >
                        {k}
                        <span className="ml-1 text-forge-dim">
                          : {formatConfigValue(r.config[k])}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 font-mono text-[10px] text-forge-dim">
                    no config supplied
                  </p>
                )}
                {r.sizing ? (
                  <p className="mt-2 font-mono text-[10px] text-forge-dim">
                    sizing:{' '}
                    {r.sizing.note ? r.sizing.note : ''}
                    {r.sizing.instances !== undefined
                      ? ' · ' + r.sizing.instances + ' instances'
                      : ''}
                    {r.sizing.storage_gb !== undefined
                      ? ' · ' + r.sizing.storage_gb + ' GB'
                      : ''}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={'topology (' + topology.length + ')'}>
        {topology.length === 0 ? (
          <p className="text-xs text-forge-dim">no edges declared.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {topology.map((e, i) => (
              <li
                key={i}
                className="rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-forge-text/90"
              >
                <span className="text-forge-amber">{e.from}</span>
                <span className="mx-2 text-forge-dim">→</span>
                <span className="text-forge-amber">{e.to}</span>
                <span className="ml-3 text-forge-dim">
                  ({byId.get(e.from)?.type ?? '?'} →{' '}
                  {byId.get(e.to)?.type ?? '?'})
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="lifecycle">
        <div className="rounded-lg border border-white/10 bg-black/30 p-3">
          <ul className="flex flex-col gap-1 font-mono text-[11px] text-forge-text/90">
            <li>
              <span className="text-forge-dim">lifecycle: </span>
              {lifecycle}
              <span className="ml-2 text-forge-dim">
                (
                {lifecycle === 'persistent'
                  ? 'data survives across runs'
                  : 'everything is recreated per run'}
                )
              </span>
            </li>
            {region ? (
              <li>
                <span className="text-forge-dim">region: </span>
                {region}
              </li>
            ) : null}
          </ul>
        </div>
      </Section>
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
