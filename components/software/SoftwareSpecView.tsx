// Presentational render of a SoftwareSpec. Same visual rhythm as the
// AgentSpec / SystemSpec views so /projects/[id] feels consistent
// whether the user landed on an agent, system, or software project.
//
// SPEC FIDELITY: optional `confidence` prop drops a per-field
// ConfidenceBadge alongside each top-level field. Absence = today's
// behaviour exactly.

import type { SoftwareSpec } from '@/lib/engine/software/spec';
import { ConfidenceBadge } from '@/components/spec/ConfidenceBadge';
import {
  levelForField,
  type SpecConfidence,
} from '@/components/spec/confidence-display';

export interface SoftwareSpecViewProps {
  spec: SoftwareSpec;
  confidence?: SpecConfidence | null;
}

export function SoftwareSpecView({
  spec,
  confidence,
}: SoftwareSpecViewProps) {
  const { goal, pages, entities, flows, auth, integrations } = spec;
  const lvl = (field: string) => levelForField(confidence, field);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            software spec
          </p>
          <h2 className="mt-1 text-2xl font-medium text-forge-text">
            {pages.length} pages · {entities.length} entities · {flows.length} flows
          </h2>
          <p className="mt-2 flex flex-wrap items-center gap-2 max-w-2xl text-sm text-forge-dim">
            {goal}
            <ConfidenceBadge level={lvl('goal')} compact />
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Pill className={auth.requires_auth ? 'border-forge-amber/40 text-forge-amber' : ''}>
            <span className="flex items-center gap-1.5">
              {auth.requires_auth ? 'auth required' : 'public · no auth'}
              <ConfidenceBadge level={lvl('auth_requires_auth')} compact />
            </span>
          </Pill>
          {auth.per_user_isolation ? (
            <Pill>
              <span className="flex items-center gap-1.5">
                per-user data
                <ConfidenceBadge level={lvl('auth_per_user_isolation')} compact />
              </span>
            </Pill>
          ) : (
            <Pill>
              <span className="flex items-center gap-1.5">
                shared data
                <ConfidenceBadge level={lvl('auth_per_user_isolation')} compact />
              </span>
            </Pill>
          )}
        </div>
      </header>

      <Section
        title={'pages (' + pages.length + ')'}
        level={lvl('pages')}
      >
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {pages.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-white/10 bg-black/30 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-xs text-forge-amber">{p.id}</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                  {p.name}
                </p>
              </div>
              <p className="mt-2 text-sm text-forge-text/90">{p.purpose}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title={'entities (' + entities.length + ')'}
        level={lvl('entities')}
      >
        <ul className="flex flex-col gap-3">
          {entities.map((e) => (
            <li
              key={e.name}
              className="rounded-lg border border-white/10 bg-black/30 p-3"
            >
              <p className="font-mono text-xs text-forge-cyan">{e.name}</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {e.fields.map((f) => (
                  <li
                    key={f.name}
                    className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] text-forge-text/90"
                  >
                    {f.name}
                    <span className="ml-1 text-forge-dim">: {f.type}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={'flows (' + flows.length + ')'} level={lvl('flows')}>
        {flows.length === 0 ? (
          <p className="text-xs text-forge-dim">no flows declared.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {flows.map((f, i) => (
              <li
                key={i}
                className="rounded-lg border border-white/10 bg-black/30 p-3"
              >
                <p className="font-mono text-xs text-forge-amber">{f.name}</p>
                <p className="mt-1 text-sm text-forge-text/90">{f.description}</p>
                {f.pages && f.pages.length > 0 ? (
                  <p className="mt-2 font-mono text-[10px] text-forge-dim">
                    walks: {f.pages.join(' → ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="auth model" level={lvl('auth_requires_auth')}>
        <div className="rounded-lg border border-white/10 bg-black/30 p-3">
          <ul className="flex flex-col gap-1 font-mono text-[11px] text-forge-text/90">
            <li>
              <span className="text-forge-dim">requires sign-in: </span>
              {auth.requires_auth ? 'yes' : 'no'}
            </li>
            <li>
              <span className="text-forge-dim">per-user isolation: </span>
              {auth.per_user_isolation ? 'yes (each user sees their own data)' : 'no (shared view)'}
            </li>
            {auth.roles && auth.roles.length > 0 ? (
              <li>
                <span className="text-forge-dim">roles: </span>
                {auth.roles.join(', ')}
              </li>
            ) : null}
          </ul>
        </div>
      </Section>

      {integrations && integrations.length > 0 ? (
        <Section title={'integrations (' + integrations.length + ')'}>
          <ul className="flex flex-wrap gap-1.5">
            {integrations.map((i) => (
              <li
                key={i}
                className="rounded-full border border-forge-cyan/30 px-2 py-0.5 font-mono text-[10px] text-forge-cyan"
              >
                {i}
              </li>
            ))}
          </ul>
        </Section>
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
