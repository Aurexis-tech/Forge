'use client';

// Activation flow: cadence + env values → authorisation gate → POST.
// Secret env values live in component state only for the duration of the
// browser tab; they are POSTed over HTTPS and cleared on success/failure.

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { GlassPanel } from '@/components/GlassPanel';
import { describeCron } from '@/lib/engine/runtime/cron';
import { useForgeStore } from '@/lib/store';
import type { BuildPlan } from '@/lib/engine/planner/schema';
import type { AgentSpec } from '@/lib/engine/spec/schema';

interface Props {
  projectId: string;
  projectName: string;
  spec: AgentSpec;
  plan: BuildPlan;
}

type Phase = 'configure' | 'gate';

const DEFAULT_CRON = '*/5 * * * *';

export function ActivateRuntimeFlow({
  projectId,
  projectName,
  spec,
  plan,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);

  const defaultMode: 'schedule' | 'always_on' =
    spec.trigger === 'schedule' ? 'schedule' : 'always_on';
  const [mode, setMode] = useState<'schedule' | 'always_on'>(defaultMode);
  const [cron, setCron] = useState<string>(DEFAULT_CRON);
  const [maxRunMs, setMaxRunMs] = useState<number>(60_000);
  const [envValues, setEnvValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(plan.env_required.map((e) => [e.key, ''])),
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
    const missing = plan.env_required
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
      for (const e of plan.env_required) {
        const v = envValues[e.key]?.trim();
        if (v) env[e.key] = v;
      }
      const res = await fetch(
        '/api/projects/' + projectId + '/runtime/activate',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            authorized: true,
            cron: cron.trim(),
            env,
            mode,
            max_run_ms: maxRunMs,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        clearEnv();
        if (plan.env_required.length > 0) setPhase('configure');
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      clearEnv();
      setCoreState('active');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Activation failed.');
    }
  }

  function clearEnv() {
    setEnvValues((prev) => {
      const cleared: Record<string, string> = {};
      for (const k of Object.keys(prev)) cleared[k] = '';
      return cleared;
    });
  }

  if (phase === 'configure') {
    return (
      <GlassPanel className="border-forge-cyan/40">
        <form onSubmit={onConfigureSubmit} className="flex flex-col gap-5">
          <div>
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              runtime · stage 07 · configure
            </h2>
            <p className="mt-2 text-sm text-forge-dim">
              Activating turns this agent into a scheduled 24/7 runtime. Each
              tick runs in a fresh isolated sandbox with real tools and your
              env. The sandbox is destroyed after every run. After 3
              consecutive failures the runtime auto-pauses.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ModeRadio
              value="always_on"
              current={mode}
              onChange={setMode}
              title="always_on"
              description="continuous availability; ticks frequently"
            />
            <ModeRadio
              value="schedule"
              current={mode}
              onChange={setMode}
              title="schedule"
              description="runs on a defined cadence"
            />
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              cron · cadence
            </span>
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="*/5 * * * *"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
            <span className="font-mono text-[10px] text-forge-amber">
              → {cadenceDescription}
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              max run time (ms)
            </span>
            <input
              type="number"
              min={5000}
              max={240000}
              step={1000}
              value={maxRunMs}
              onChange={(e) => setMaxRunMs(Number(e.target.value))}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
          </label>

          {plan.env_required.length > 0 ? (
            <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan">
                environment values
              </p>
              <p className="text-xs text-forge-dim">
                Secret values are encrypted with{' '}
                <span className="text-forge-text">APP_ENC_KEY</span>{' '}
                and injected only into the isolated sandbox at run time.
                Forge never logs them.
              </p>
              <ul className="flex flex-col gap-4">
                {plan.env_required.map((env) => (
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
                      value={envValues[env.key] ?? ''}
                      onChange={(e) =>
                        setEnvValues((prev) => ({
                          ...prev,
                          [env.key]: e.target.value,
                        }))
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
            </div>
          ) : null}

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

  const secretCount = plan.env_required.filter(
    (e) => e.secret && (envValues[e.key]?.trim() ?? '').length > 0,
  ).length;

  return (
    <AuthorizationGate
      title={
        'Activate ' +
        projectName +
        ' to run automatically on ' +
        cadenceDescription +
        '?'
      }
      summary={[
        { label: 'mode', value: mode },
        { label: 'cadence', value: cron + '  (' + cadenceDescription + ')' },
        { label: 'max run', value: Math.round(maxRunMs / 1000) + 's per tick' },
        ...(plan.env_required.length > 0
          ? [
              {
                label: 'env',
                value:
                  secretCount +
                  ' secret · ' +
                  (Object.values(envValues).filter((v) => v.trim().length > 0).length -
                    secretCount) +
                  ' plain — injected only into the isolated sandbox',
              },
            ]
          : []),
      ]}
      helper={
        'The agent will execute on its own from now on and may incur real ' +
        'usage (LLM tokens, third-party API calls, emails, etc). After 3 ' +
        'consecutive failures the runtime auto-pauses so a broken agent ' +
        'never loops forever.'
      }
      confirmLabel="Activate runtime"
      cancelLabel="Back"
      onApprove={onApprove}
      onCancel={() => setPhase('configure')}
      error={error}
    />
  );
}

function ModeRadio({
  value,
  current,
  onChange,
  title,
  description,
}: {
  value: 'schedule' | 'always_on';
  current: 'schedule' | 'always_on';
  onChange: (v: 'schedule' | 'always_on') => void;
  title: string;
  description: string;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={
        'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition ' +
        (active
          ? 'border-forge-amber/60 bg-forge-amber/10'
          : 'border-white/10 bg-black/30 hover:border-white/30')
      }
    >
      <span
        className={
          'font-mono text-xs uppercase tracking-[0.25em] ' +
          (active ? 'text-forge-amber' : 'text-forge-text')
        }
      >
        {title}
      </span>
      <span className="text-xs text-forge-dim">{description}</span>
    </button>
  );
}
