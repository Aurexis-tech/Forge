'use client';

// Phase 2 (Systems) runtime activation flow. Mirrors
// components/runtime/ActivateRuntimeFlow.tsx — cadence + env values →
// AuthorizationGate → POST. REUSES AuthorizationGate; reuses the
// same client-side discipline for env values (component state only,
// dropped on success/failure).

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { GlassPanel } from '@/components/GlassPanel';
import { describeCron } from '@/lib/engine/runtime/cron';
import { useForgeStore } from '@/lib/store';
import type { BuildPlan } from '@/lib/engine/planner/schema';

interface Props {
  projectId: string;
  projectName: string;
  // Aggregated env from the OrchestrationPlan (same shape as a Phase 1
  // BuildPlan.env_required), produced server-side via
  // aggregateSystemEnvRequired before this flow renders.
  envRequired: BuildPlan['env_required'];
  // Whether the spec's triggers include 'schedule' — drives the
  // default mode.
  hasScheduleTrigger: boolean;
  // For copy: how many sub-agents will run inside the orchestration.
  nodeCount: number;
}

type Phase = 'configure' | 'gate';

const DEFAULT_CRON = '*/5 * * * *';

export function SystemActivateRuntimeFlow({
  projectId,
  projectName,
  envRequired,
  hasScheduleTrigger,
  nodeCount,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);

  const defaultMode: 'schedule' | 'always_on' = hasScheduleTrigger
    ? 'schedule'
    : 'always_on';
  const [mode, setMode] = useState<'schedule' | 'always_on'>(defaultMode);
  const [cron, setCron] = useState<string>(DEFAULT_CRON);
  const [maxRunMs, setMaxRunMs] = useState<number>(60_000);
  const [envValues, setEnvValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(envRequired.map((e) => [e.key, ''])),
  );
  const [phase, setPhase] = useState<Phase>('configure');
  const [error, setError] = useState<string | null>(null);

  const cadenceDescription = useMemo(() => describeCron(cron), [cron]);

  function onConfigureSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!cron.trim()) {
      setError('Cron expression is required.');
      return;
    }
    const missing = envRequired
      .filter((env) => env.secret && !envValues[env.key]?.trim())
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
      const env: Record<string, string> = {};
      for (const e of envRequired) {
        const v = envValues[e.key]?.trim();
        if (v) env[e.key] = v;
      }
      const res = await fetch(
        '/api/projects/' + projectId + '/system/runtime/activate',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            authorized: true,
            cron,
            env,
            mode,
            max_run_ms: maxRunMs,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // Drop env values from memory on failure.
        setEnvValues((prev) => {
          const cleared: Record<string, string> = {};
          for (const k of Object.keys(prev)) cleared[k] = '';
          return cleared;
        });
        setCoreState('error');
        throw new Error(body.error ?? 'activation failed');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Activation failed.');
    }
  }

  if (phase === 'configure') {
    return (
      <GlassPanel>
        <form onSubmit={onConfigureSubmit} className="flex flex-col gap-4">
          <div>
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              system runtime · stage 07 · activation
            </h2>
            <p className="mt-2 text-sm text-forge-dim">
              Pick a cadence + supply the {envRequired.length} env key
              {envRequired.length === 1 ? '' : 's'} the {nodeCount} sub-agent
              {nodeCount === 1 ? '' : 's'} need at runtime. The orchestrator
              runs the WHOLE system as one coordinated unit per tick — the
              max-steps ceiling + per-handoff validation are already baked in.
              ONE run = ONE governed unit (the shared budget + kill switch
              bind the whole orchestration, not each agent).
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                mode
              </span>
              <select
                value={mode}
                onChange={(e) =>
                  setMode(e.target.value as 'schedule' | 'always_on')
                }
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text"
              >
                <option value="schedule">schedule (cron tick fires runs)</option>
                <option value="always_on">always_on (cron + on-demand)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                cron
              </span>
              <input
                type="text"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="*/5 * * * *"
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text"
              />
              <p className="font-mono text-[10px] text-forge-dim">
                {cadenceDescription}
              </p>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                max_run_ms (whole-run wall-clock cap)
              </span>
              <input
                type="number"
                min={5_000}
                max={240_000}
                step={1_000}
                value={maxRunMs}
                onChange={(e) =>
                  setMaxRunMs(Math.max(5_000, Number(e.target.value) || 60_000))
                }
                className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text"
              />
            </label>
          </div>

          {envRequired.length > 0 ? (
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
                  <p className="font-mono text-[10px] text-forge-dim/80">{env.why}</p>
                  <input
                    id={'env-' + env.key}
                    type={env.secret ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    value={envValues[env.key] ?? ''}
                    onChange={(e) =>
                      setEnvValues((prev) => ({
                        ...prev,
                        [env.key]: e.target.value,
                      }))
                    }
                    className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70"
                    placeholder={env.secret ? 'paste secret' : 'value'}
                  />
                </li>
              ))}
            </ul>
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
      title={'Activate this system to run on a cron?'}
      summary={[
        { label: 'project', value: projectName },
        { label: 'mode', value: mode },
        { label: 'cron', value: cron + '  (' + cadenceDescription + ')' },
        {
          label: 'max_run_ms',
          value: String(maxRunMs) + ' (whole orchestration, all agents)',
        },
        {
          label: 'env keys',
          value:
            envRequired.length === 0
              ? 'none required'
              : envRequired.map((e) => e.key).join(', '),
        },
        {
          label: 'shared ceiling',
          value:
            'budget + kill switch bind the WHOLE run (one run = one governed unit)',
        },
      ]}
      helper={
        'Each tick: an isolated sandbox is created, the orchestrator runs in LIVE mode (real tools, real network), the max-steps ceiling and per-handoff validation are enforced by the generated orchestrator. Three consecutive failures auto-pause the runtime. Only the KEY NAMES of any secrets are stored in the Forge — values are AES-256-GCM-encrypted at rest and decrypted only inside the sandbox.'
      }
      confirmLabel="Activate system runtime"
      cancelLabel="Not yet"
      onApprove={onApprove}
      onCancel={() => setPhase('configure')}
      error={error}
    />
  );
}
