'use client';

// Phase 3-5a (Software) DB provisioning flow. Mirrors the Phase 2
// SystemDeployFlow shape — configure inputs → AuthorizationGate →
// POST /software/db/provision. REUSES the AuthorizationGate; the
// gate is mandatory because provisioning a real database (or
// connecting one) is consequential.
//
// Two provider kinds:
//   - managed — needs a 'supabase' connection upstream. The user
//     optionally names the project + picks region/org; nothing else
//     to type. The route resolves the Management token server-side.
//   - byo     — the user pastes their existing Supabase project's
//     URL + anon key + service-role key. All three are forwarded over
//     HTTPS to the route. The service-role key is encrypted at rest
//     immediately and NEVER returned in any response.
//
// Client-side secret discipline: the service-role and anon key live
// only in component state. On success / failure they are cleared so
// a re-render can't leak them.

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  projectName: string;
  // True when the user has a 'supabase' connection upstream. Drives
  // whether the 'managed' tab is enabled.
  hasSupabaseConnection: boolean;
  // For copy: how many entity tables landed in the RLS migration.
  entityCount: number;
  // The previous provision attempt's error message, if any.
  failedMessage?: string | null;
}

type Phase = 'configure' | 'gate';
type Kind = 'managed' | 'byo';

export function ProvisionDbFlow({
  projectId,
  projectName,
  hasSupabaseConnection,
  entityCount,
  failedMessage,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);

  const [kind, setKind] = useState<Kind>(
    hasSupabaseConnection ? 'managed' : 'byo',
  );
  const [phase, setPhase] = useState<Phase>('configure');
  const [error, setError] = useState<string | null>(failedMessage ?? null);

  // Managed inputs.
  const [projName, setProjName] = useState<string>(
    deriveProjectName(projectName),
  );
  const [region, setRegion] = useState<string>('us-east-1');
  const [organizationId, setOrganizationId] = useState<string>('');

  // BYO inputs. The service-role key is the only secret here; we use
  // a password input + autoComplete=off to keep it out of the browser
  // address-bar history.
  const [byoUrl, setByoUrl] = useState<string>('');
  const [byoAnon, setByoAnon] = useState<string>('');
  const [byoServiceRole, setByoServiceRole] = useState<string>('');

  function clearByoSecrets() {
    setByoServiceRole('');
    setByoAnon('');
  }

  function onConfigureSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (kind === 'managed') {
      if (!hasSupabaseConnection) {
        setError(
          'Connect a Supabase Management token first, or switch to bring-your-own.',
        );
        return;
      }
      if (!projName.trim()) {
        setError('Project name is required for managed provisioning.');
        return;
      }
    } else {
      if (!byoUrl.trim() || !byoAnon.trim() || !byoServiceRole.trim()) {
        setError(
          'Bring-your-own provisioning needs the Supabase URL, the anon key, AND the service-role key.',
        );
        return;
      }
      if (!/^https:\/\//.test(byoUrl.trim())) {
        setError('Supabase URL must start with https://');
        return;
      }
    }
    setPhase('gate');
  }

  async function onApprove() {
    setError(null);
    setCoreState('working');
    try {
      const body =
        kind === 'managed'
          ? {
              authorized: true,
              provider_kind: 'managed' as const,
              project_name: projName.trim(),
              region: region.trim() || undefined,
              organization_id: organizationId.trim() || undefined,
            }
          : {
              authorized: true,
              provider_kind: 'byo' as const,
              supabase_url: byoUrl.trim(),
              anon_key: byoAnon.trim(),
              service_role_key: byoServiceRole.trim(),
            };
      const res = await fetch(
        '/api/projects/' + projectId + '/software/db/provision',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      // Always clear the BYO secrets — even on success, we have no
      // reason to keep them in the browser after the POST.
      clearByoSecrets();
      if (!res.ok) {
        setCoreState('error');
        throw new Error(payload.error ?? 'provisioning failed');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Provisioning failed.');
    }
  }

  if (phase === 'configure') {
    return (
      <GlassPanel>
        <form onSubmit={onConfigureSubmit} className="flex flex-col gap-5">
          <div>
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              software db · stage 05a · provision
            </h2>
            <p className="mt-2 text-sm text-forge-dim">
              The sandbox proved the RLS migration isolates {entityCount}{' '}
              entity table{entityCount === 1 ? '' : 's'} cross-user. Now
              provision (or connect) the real Supabase database that the
              deployed app will hit, and apply that <span className="text-forge-amber">exact same</span>{' '}
              migration to it. The next gate (push + deploy) is closed
              until this lands.
            </p>
          </div>

          <div className="flex gap-2">
            <KindTab
              label="managed"
              active={kind === 'managed'}
              disabled={!hasSupabaseConnection}
              onClick={() => setKind('managed')}
              hint={
                hasSupabaseConnection
                  ? 'Create a fresh Supabase project under your account.'
                  : 'Needs a connected Supabase Management token.'
              }
            />
            <KindTab
              label="bring-your-own"
              active={kind === 'byo'}
              onClick={() => setKind('byo')}
              hint="Connect an existing Supabase project you control."
            />
          </div>

          {kind === 'managed' ? (
            <fieldset className="flex flex-col gap-3">
              <FieldLabel htmlFor="prov-name">project name</FieldLabel>
              <input
                id="prov-name"
                type="text"
                value={projName}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setProjName(e.target.value)}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
              />
              <FieldLabel htmlFor="prov-region">region</FieldLabel>
              <input
                id="prov-region"
                type="text"
                value={region}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setRegion(e.target.value)}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
                placeholder="us-east-1"
              />
              <FieldLabel htmlFor="prov-org">
                organization id (optional)
              </FieldLabel>
              <input
                id="prov-org"
                type="text"
                value={organizationId}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setOrganizationId(e.target.value)}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
                placeholder="leave blank to use the default org"
              />
              <p className="font-mono text-[10px] text-forge-dim/80">
                The Supabase Management token resolves server-side from
                your connection. It is never transmitted via this form.
              </p>
            </fieldset>
          ) : (
            <fieldset className="flex flex-col gap-3">
              <FieldLabel htmlFor="byo-url">supabase url</FieldLabel>
              <input
                id="byo-url"
                type="text"
                value={byoUrl}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setByoUrl(e.target.value)}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
                placeholder="https://xxxx.supabase.co"
              />
              <FieldLabel htmlFor="byo-anon">anon key</FieldLabel>
              <input
                id="byo-anon"
                type="password"
                value={byoAnon}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setByoAnon(e.target.value)}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
                placeholder="paste anon key"
              />
              <FieldLabel htmlFor="byo-sr">
                service-role key · secret · server-only
              </FieldLabel>
              <input
                id="byo-sr"
                type="password"
                value={byoServiceRole}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setByoServiceRole(e.target.value)}
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
                placeholder="paste service-role key"
              />
              <p className="font-mono text-[10px] text-forge-dim/80">
                The service-role key is POSTed to the server over HTTPS,
                encrypted at rest with AES-256-GCM, and dropped from this
                browser session immediately after the request returns. It
                is never returned in any response.
              </p>
            </fieldset>
          )}

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-3">
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-xl border border-forge-cyan/60 bg-forge-cyan/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-cyan shadow-cyan transition hover:bg-forge-cyan/25"
            >
              Continue to authorisation
            </button>
          </div>
        </form>
      </GlassPanel>
    );
  }

  // Phase: gate.
  const summary =
    kind === 'managed'
      ? [
          { label: 'mode', value: 'managed · supabase management api' },
          { label: 'project name', value: projName },
          { label: 'region', value: region || 'provider default' },
          {
            label: 'migration',
            value:
              entityCount +
              ' entity table' +
              (entityCount === 1 ? '' : 's') +
              ' (the exact SQL the isolation test validated)',
          },
        ]
      : [
          { label: 'mode', value: 'bring-your-own · existing project' },
          { label: 'supabase url', value: byoUrl },
          { label: 'service-role', value: '•••• ' + byoServiceRole.slice(-4) },
          {
            label: 'migration',
            value:
              entityCount +
              ' entity table' +
              (entityCount === 1 ? '' : 's') +
              ' (the exact SQL the isolation test validated)',
          },
        ];

  return (
    <AuthorizationGate
      title={
        kind === 'managed'
          ? 'Provision a new Supabase project and apply the schema?'
          : 'Connect this Supabase project and apply the schema?'
      }
      summary={summary}
      helper={
        kind === 'managed'
          ? 'A fresh Supabase project will be created under your account via the Management API. The service-role key returned is encrypted at rest immediately — it never leaves the server. Push + deploy remain closed until this lands.'
          : 'The generated RLS migration will be applied to the Supabase project at the URL above. Your service-role key is encrypted at rest immediately — it never leaves the server. Push + deploy remain closed until this lands.'
      }
      confirmLabel={kind === 'managed' ? 'Provision database' : 'Apply schema'}
      cancelLabel="Back"
      onApprove={onApprove}
      onCancel={() => {
        clearByoSecrets();
        setPhase('configure');
      }}
      error={error}
    />
  );
}

function deriveProjectName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'forge-software-app'
  );
}

function KindTab({
  label,
  active,
  disabled,
  onClick,
  hint,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'flex-1 rounded-xl border px-3 py-3 text-left transition ' +
        (active
          ? 'border-forge-cyan/60 bg-forge-cyan/15 text-forge-cyan'
          : 'border-white/10 bg-black/30 text-forge-dim hover:border-white/30 hover:text-forge-text') +
        (disabled ? ' cursor-not-allowed opacity-60' : '')
      }
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.3em]">
        {label}
      </p>
      <p className="mt-1 text-xs">{hint}</p>
    </button>
  );
}

function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim"
    >
      {children}
    </label>
  );
}
