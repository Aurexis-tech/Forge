'use client';

// Phase 3-5b (Software) deploy flow. Mirrors SystemDeployFlow but
// surfaces the WIRED DB env up front so the reviewer sees, before
// approving, exactly what will land on Vercel:
//
//   - NEXT_PUBLIC_SUPABASE_URL          (public — bundled into browser)
//   - NEXT_PUBLIC_SUPABASE_ANON_KEY     (public — bundled into browser)
//   - SUPABASE_SERVICE_ROLE_KEY         (encrypted · server-only)
//
// The service-role value is shown ONLY as `•••• last4`. It is never
// rendered in full anywhere in this component. The deploy route reads
// the real value server-side from the encrypted software_databases
// row; the browser never sees it.
//
// Optional extra secrets (e.g. RESEND_API_KEY) flow through the same
// form. They are POSTed in the body's `secrets` field, forwarded to
// Vercel, and dropped from memory after the POST.

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { GlassPanel } from '@/components/GlassPanel';
import { deriveRepoName } from '@/lib/engine/integrations/github-name';
import { useForgeStore } from '@/lib/store';

export interface SoftwareExtraSecret {
  key: string;
  why: string;
  secret: boolean;
}

interface Props {
  projectId: string;
  projectName: string;
  accountLogin: string;
  filesCount: number;
  // Public DB env that will be wired from the provisioned record.
  supabaseUrl: string;
  // The anon key is technically public, but we still abbreviate it
  // in the UI to keep the visual signal manageable.
  anonKey: string;
  // Last-4 of the service-role for masked display. The full value
  // never reaches the browser.
  serviceRoleLast4: string;
  // Anything beyond the wired DB env that the app needs. Empty for
  // most apps; non-empty for software that pulls in email/payment
  // tools at the spec layer (future extension).
  extraEnvRequired?: SoftwareExtraSecret[];
}

type Phase = 'review' | 'gate';

export function SoftwareDeployFlow({
  projectId,
  projectName,
  accountLogin,
  filesCount,
  supabaseUrl,
  anonKey,
  serviceRoleLast4,
  extraEnvRequired = [],
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);

  const hasExtraEnv = extraEnvRequired.length > 0;
  const [phase, setPhase] = useState<Phase>(hasExtraEnv ? 'review' : 'review');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(extraEnvRequired.map((e) => [e.key, ''])),
  );
  const [error, setError] = useState<string | null>(null);

  const deployTargetName = useMemo(
    () => deriveRepoName(projectName),
    [projectName],
  );

  function onReviewSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const missing = extraEnvRequired
      .filter((env) => env.secret && !values[env.key]?.trim())
      .map((env) => env.key);
    if (missing.length > 0) {
      setError('Required secret(s) missing: ' + missing.join(', '));
      return;
    }
    setPhase('gate');
  }

  async function onApprove() {
    setError(null);
    setCoreState('working');
    try {
      const secretsPayload: Record<string, string> = {};
      for (const env of extraEnvRequired) {
        const v = values[env.key]?.trim();
        if (v) secretsPayload[env.key] = v;
      }
      const res = await fetch(
        '/api/projects/' + projectId + '/software/build/deploy',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            authorized: true,
            secrets: secretsPayload,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        log_tail?: string;
      };
      if (!res.ok) {
        // Drop secret values immediately so a re-render can't carry them.
        setValues((prev) => {
          const cleared: Record<string, string> = {};
          for (const k of Object.keys(prev)) cleared[k] = '';
          return cleared;
        });
        setCoreState('error');
        const tail = body.log_tail
          ? '\n\n[deploy logs]\n' + body.log_tail.slice(-1000)
          : '';
        throw new Error((body.error ?? 'deploy failed') + tail);
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Deploy failed.');
    }
  }

  if (phase === 'review') {
    return (
      <GlassPanel>
        <form onSubmit={onReviewSubmit} className="flex flex-col gap-5">
          <div>
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              deploy · stage 06 · env wiring
            </h2>
            <p className="mt-2 text-sm text-forge-dim">
              These env vars will be set on Vercel before the deployment runs.
              The PUBLIC vars are bundled into the browser JS (Supabase URL +
              anon key are public by design — <span className="text-forge-amber">RLS in the database is what protects each user&apos;s rows</span>). The SECRET var is{' '}
              <span className="text-forge-amber">stored encrypted on Vercel</span>{' '}
              and never reaches the browser.
            </p>
          </div>

          <ul className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-4">
            <EnvRow
              keyName="NEXT_PUBLIC_SUPABASE_URL"
              value={supabaseUrl}
              kind="public"
            />
            <EnvRow
              keyName="NEXT_PUBLIC_SUPABASE_ANON_KEY"
              value={abbreviate(anonKey)}
              kind="public"
            />
            <EnvRow
              keyName="SUPABASE_SERVICE_ROLE_KEY"
              value={'•••• ' + serviceRoleLast4}
              kind="server-only"
            />
          </ul>

          {hasExtraEnv ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                additional env (server-only secrets)
              </legend>
              {extraEnvRequired.map((env) => (
                <div key={env.key} className="flex flex-col gap-1.5">
                  <label
                    htmlFor={'env-' + env.key}
                    className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim"
                  >
                    {env.key}
                    {env.secret ? ' · secret' : ''}
                  </label>
                  <p className="font-mono text-[10px] text-forge-dim/80">
                    {env.why}
                  </p>
                  <input
                    id={'env-' + env.key}
                    type={env.secret ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    value={values[env.key] ?? ''}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [env.key]: e.target.value,
                      }))
                    }
                    className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
                    placeholder={env.secret ? 'paste secret' : 'value'}
                  />
                </div>
              ))}
            </fieldset>
          ) : null}

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

  return (
    <AuthorizationGate
      title={'Deploy the app to Vercel with the wired database?'}
      summary={[
        { label: 'account', value: '@' + accountLogin },
        { label: 'vercel project', value: deployTargetName },
        {
          label: 'contents',
          value: filesCount + ' files · Next.js + Supabase app',
        },
        {
          label: 'public env',
          value: 'NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY',
        },
        {
          label: 'server-only env',
          value:
            'SUPABASE_SERVICE_ROLE_KEY · encrypted · NOT exposed to browser',
        },
      ]}
      helper={
        'The service-role key is decrypted server-side and posted to Vercel as ' +
        'an encrypted environment variable. It is NEVER exposed to the browser ' +
        'bundle and NEVER returned by this request. Only key NAMES land in the ' +
        'Forge audit log.'
      }
      confirmLabel="Deploy app"
      cancelLabel="Back"
      onApprove={onApprove}
      onCancel={() => {
        setPhase('review');
      }}
      error={error}
    />
  );
}

function EnvRow({
  keyName,
  value,
  kind,
}: {
  keyName: string;
  value: string;
  kind: 'public' | 'server-only';
}) {
  const isPublic = kind === 'public';
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] text-forge-text">{keyName}</span>
        <span
          className={
            'rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] ' +
            (isPublic
              ? 'border-emerald-400/40 text-emerald-300'
              : 'border-forge-amber/50 text-forge-amber')
          }
        >
          {isPublic
            ? 'public · bundled into browser'
            : 'server-only secret · not exposed to the browser'}
        </span>
      </div>
      <span className="break-all font-mono text-[11px] text-forge-dim">
        {value}
      </span>
    </li>
  );
}

function abbreviate(s: string): string {
  if (s.length <= 14) return s;
  return s.slice(0, 6) + '…' + s.slice(-4);
}
