'use client';

// Client orchestrator for the deploy flow:
//   (optional) secrets entry → authorisation gate → POST /build/deploy
//
// Secret values live in component state ONLY for the duration of the
// browser tab session. They're sent over HTTPS to /build/deploy and never
// stored client-side beyond that POST.

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
  envRequired: BuildPlan['env_required'];
  framework: string;
}

type Phase = 'secrets' | 'gate';

export function DeployFlow({
  projectId,
  projectName,
  accountLogin,
  filesCount,
  envRequired,
  framework,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);

  const hasAnyEnv = envRequired.length > 0;
  const [phase, setPhase] = useState<Phase>(hasAnyEnv ? 'secrets' : 'gate');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(envRequired.map((e) => [e.key, ''])),
  );
  const [error, setError] = useState<string | null>(null);

  const deployTargetName = useMemo(() => deriveRepoName(projectName), [projectName]);

  function onSecretsSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    // Validate that every secret has a value. Non-secret slots are optional.
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
      const res = await fetch('/api/projects/' + projectId + '/build/deploy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          authorized: true,
          secrets: secretsPayload,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        log_tail?: string;
      };
      if (!res.ok) {
        // Drop the secret values from component state immediately on failure.
        setValues((prev) => {
          const cleared: Record<string, string> = {};
          for (const k of Object.keys(prev)) cleared[k] = '';
          return cleared;
        });
        if (hasAnyEnv) setPhase('secrets');
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      // Clear secret values from memory before the page refreshes.
      setValues((prev) => {
        const cleared: Record<string, string> = {};
        for (const k of Object.keys(prev)) cleared[k] = '';
        return cleared;
      });
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Deploy failed.');
    }
  }

  if (phase === 'secrets') {
    return (
      <GlassPanel className="border-forge-cyan/40">
        <form onSubmit={onSecretsSubmit} className="flex flex-col gap-5">
          <div>
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              deploy · environment values
            </h2>
            <p className="mt-2 text-sm text-forge-dim">
              These values will be set on your Vercel project. Secret fields
              are stored encrypted by Vercel; the Forge keeps only the KEY
              NAMES and{' '}
              <span className="text-forge-text">never persists the values</span>.
            </p>
          </div>

          <ul className="flex flex-col gap-4">
            {envRequired.map((env) => (
              <li key={env.key} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={'env-' + env.key}
                    className="font-mono text-sm text-forge-amber"
                  >
                    {env.key}
                  </label>
                  <span
                    className={
                      'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] ' +
                      (env.secret
                        ? 'border-rose-400/40 text-rose-300'
                        : 'border-white/15 text-forge-dim')
                    }
                  >
                    {env.secret ? 'secret · required' : 'plain · optional'}
                  </span>
                </div>
                <p className="text-xs text-forge-dim">{env.why}</p>
                <input
                  id={'env-' + env.key}
                  type={env.secret ? 'password' : 'text'}
                  value={values[env.key] ?? ''}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [env.key]: e.target.value }))
                  }
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={env.secret ? 'paste secret' : 'optional'}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
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

          <div className="flex items-center justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25"
            >
              Continue to authorisation
            </button>
          </div>
        </form>
      </GlassPanel>
    );
  }

  const secretCount = envRequired.filter(
    (e) => e.secret && (values[e.key]?.trim() ?? '').length > 0,
  ).length;
  const plainCount = envRequired.filter(
    (e) => !e.secret && (values[e.key]?.trim() ?? '').length > 0,
  ).length;

  return (
    <AuthorizationGate
      title={'Deploy ' + projectName + ' to Vercel and make it live at a public URL?'}
      summary={[
        { label: 'account', value: '@' + accountLogin },
        { label: 'project', value: deployTargetName + ' (target: production)' },
        { label: 'files', value: filesCount + ' files uploaded' },
        { label: 'framework', value: framework },
        ...(envRequired.length > 0
          ? [
              {
                label: 'env',
                value:
                  secretCount +
                  ' secret · ' +
                  plainCount +
                  ' plain — set on Vercel; values NOT persisted by Forge',
              },
            ]
          : []),
      ]}
      helper={
        'The live URL is public by design — anyone who knows it can call the ' +
        'agent. Add per-agent access control inside the agent handler if needed.'
      }
      confirmLabel="Deploy to Vercel"
      cancelLabel="Back"
      onApprove={onApprove}
      onCancel={() => {
        if (hasAnyEnv) setPhase('secrets');
      }}
      error={error}
    />
  );
}
