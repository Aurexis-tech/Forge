'use client';

// Phase 2 (Systems) deploy flow. Mirrors components/vercel/DeployFlow.tsx
// — optional secrets entry → AuthorizationGate → POST /system/build/deploy
// with { authorized: true, secrets }. REUSES AuthorizationGate; reuses
// the same client-side discipline for secret values (component state
// only, dropped on failure).
//
// Secrets are forwarded to the server over HTTPS and never stored
// client-side beyond that POST. Vercel persists them; the Forge keeps
// only the KEY NAMES.

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { GlassPanel } from '@/components/GlassPanel';
import { deriveRepoName } from '@/lib/engine/integrations/github-name';
import { useForgeStore } from '@/lib/store';
import type { BuildPlan } from '@/lib/engine/planner/schema';

interface Props {
  projectId: string;
  projectName: string;
  accountLogin: string;
  filesCount: number;
  moduleCount: number;
  // The aggregated env requirements from the OrchestrationPlan, in the
  // same shape as a BuildPlan's env_required so we can reuse the same
  // form rendering as the Phase 1 deploy flow.
  envRequired: BuildPlan['env_required'];
}

type Phase = 'secrets' | 'gate';

export function SystemDeployFlow({
  projectId,
  projectName,
  accountLogin,
  filesCount,
  moduleCount,
  envRequired,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);

  const hasAnyEnv = envRequired.length > 0;
  const [phase, setPhase] = useState<Phase>(hasAnyEnv ? 'secrets' : 'gate');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(envRequired.map((e) => [e.key, ''])),
  );
  const [error, setError] = useState<string | null>(null);

  const deployTargetName = useMemo(
    () => deriveRepoName(projectName),
    [projectName],
  );

  function onSecretsSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const missingSecrets = envRequired
      .filter((env) => env.secret && !values[env.key]?.trim())
      .map((env) => env.key);
    if (missingSecrets.length > 0) {
      setError('Required secret(s) missing: ' + missingSecrets.join(', '));
      return;
    }
    setPhase('gate');
  }

  async function onApprove() {
    setError(null);
    setCoreState('working');
    try {
      const secretsPayload: Record<string, string> = {};
      for (const env of envRequired) {
        const v = values[env.key]?.trim();
        if (v) secretsPayload[env.key] = v;
      }
      const res = await fetch(
        '/api/projects/' + projectId + '/system/build/deploy',
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
        // Drop the secret values from component state immediately on
        // failure so a re-render can't leak them.
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

  if (phase === 'secrets') {
    return (
      <GlassPanel>
        <form onSubmit={onSecretsSubmit} className="flex flex-col gap-4">
          <div>
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              deploy · stage 06 · secrets
            </h2>
            <p className="mt-2 text-sm text-forge-dim">
              The aggregated tools across this system&apos;s sub-agents need{' '}
              {envRequired.length} environment variable
              {envRequired.length === 1 ? '' : 's'}. Values are POSTed to the
              server, forwarded to Vercel&apos;s env API, and dropped from
              memory. Only the KEY NAMES are stored in the Forge.
            </p>
          </div>

          <ul className="flex flex-col gap-3">
            {envRequired.map((env) => (
              <li key={env.key} className="flex flex-col gap-1.5">
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
                    setValues((prev) => ({ ...prev, [env.key]: e.target.value }))
                  }
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
                  placeholder={env.secret ? 'paste secret' : 'value'}
                />
              </li>
            ))}
          </ul>

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
      title={'Deploy the full system to Vercel?'}
      summary={[
        { label: 'account', value: '@' + accountLogin },
        { label: 'vercel project', value: deployTargetName },
        {
          label: 'contents',
          value:
            filesCount +
            ' files · orchestrator + ' +
            moduleCount +
            ' module' +
            (moduleCount === 1 ? '' : 's') +
            ' as one deployable',
        },
        envRequired.length > 0
          ? {
              label: 'env keys',
              value:
                envRequired.length +
                ' (' +
                envRequired.map((e) => e.key).join(', ') +
                ')',
            }
          : { label: 'env keys', value: 'none required' },
      ]}
      helper={
        'Deploys the system as one unit — the generated orchestrator is the ' +
        'entrypoint and dispatches into each sub-agent module in topological ' +
        'order. Only the KEY NAMES of any secrets are persisted in the Forge; ' +
        'values live only on Vercel.'
      }
      confirmLabel="Deploy system"
      cancelLabel="Not yet"
      onApprove={onApprove}
      onCancel={() => {
        /* no-op — the gate stays mounted until status changes */
      }}
      error={error}
    />
  );
}
