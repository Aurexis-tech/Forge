'use client';

// Settings UI for BYOK keys (anthropic + e2b). Pure DOM — masked input
// for paste, connected-state badge with last4, remove button. Never
// renders or fetches the full key.

import { useEffect, useState, type FormEvent } from 'react';
import { EmberCard } from '@/components/forge/EmberCard';
import { HeatBadge } from '@/components/forge/HeatBadge';
import { keyStatusTone } from '@/lib/forge-heat';

type Provider = 'anthropic' | 'e2b';

interface ProviderStatus {
  connected: boolean;
  key_last4: string | null;
  connected_at: string | null;
}

interface StatusResponse {
  anthropic: ProviderStatus;
  e2b: ProviderStatus;
}

interface CardCopy {
  label: string;
  blurb: string;
  hint: string;
}

const COPY: Record<Provider, CardCopy> = {
  anthropic: {
    label: 'Anthropic',
    blurb: 'Powers spec extraction, planning, and codegen.',
    hint: 'Generate a key at console.anthropic.com → API keys.',
  },
  e2b: {
    label: 'E2B',
    blurb: 'Sandboxes the generated agent during tests and live runtimes.',
    hint: 'Generate a key at e2b.dev → Account → API keys.',
  },
};

export function KeysForm() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/connections/keys', { method: 'GET' });
      const body = (await res.json()) as StatusResponse | { error?: string };
      if (!res.ok) throw new Error((body as { error?: string }).error ?? 'load failed');
      setStatus(body as StatusResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      ) : null}

      <EmberCard tone="none">
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-cool-cyan">
            why keys live here
          </p>
          <p className="text-sm text-forge-text/90">
            Your keys are encrypted at rest (AES-256-GCM) and used only to
            run <span className="text-forge-text">your own</span> builds and
            runtimes. <span className="text-forge-text">We never see or log
            them</span>; the UI only ever shows the last four characters.
          </p>
        </div>
      </EmberCard>

      <ProviderCard
        provider="anthropic"
        status={status?.anthropic ?? null}
        loading={loading}
        onChanged={refresh}
      />
      <ProviderCard
        provider="e2b"
        status={status?.e2b ?? null}
        loading={loading}
        onChanged={refresh}
      />
    </div>
  );
}

function ProviderCard({
  provider,
  status,
  loading,
  onChanged,
}: {
  provider: Provider;
  status: ProviderStatus | null;
  loading: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const copy = COPY[provider];
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const connected = status?.connected ?? false;
  const tone = keyStatusTone(connected);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const trimmed = key.trim();
    if (trimmed.length < 8) {
      setError('Paste a real key.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/connections/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, key: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        key_last4?: string;
      };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setKey('');
      setInfo('connected · •••• ' + (body.key_last4 ?? '????'));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'connect failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove() {
    if (!confirm('Remove your ' + copy.label + ' key from the Forge?')) return;
    setError(null);
    setInfo(null);
    setRemoveBusy(true);
    try {
      const res = await fetch(
        '/api/connections/keys?provider=' + provider,
        { method: 'DELETE' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'remove failed');
      setInfo('removed');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'remove failed');
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <EmberCard tone={tone.card}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-cool-cyan">
              {copy.label}
            </p>
            <p className="mt-1 text-sm text-forge-text/90">{copy.blurb}</p>
          </div>
          <ConnectedPill connected={connected} keyLast4={status?.key_last4 ?? null} loading={loading} />
        </div>

        {connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
            <p className="font-mono text-[11px] text-forge-text/90">
              ••••&nbsp;{status?.key_last4 ?? '????'} ·{' '}
              {status?.connected_at
                ? new Date(status.connected_at).toLocaleString()
                : '—'}
            </p>
            <button
              type="button"
              onClick={onRemove}
              disabled={removeBusy}
              className="rounded-xl border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-rose-400/50 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {removeBusy ? 'removing…' : 'remove'}
            </button>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              {connected ? 'replace key' : 'paste key'}
            </span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={'paste your ' + provider + ' key'}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
            <span className="font-mono text-[10px] text-forge-dim">{copy.hint}</span>
          </label>

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              {error}
            </p>
          ) : null}
          {info ? (
            <p className="rounded-lg border border-emerald-400/30 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-200">
              {info}
            </p>
          ) : null}

          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl border border-forge-cyan/60 bg-forge-cyan/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-cyan shadow-cyan transition hover:bg-forge-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'verifying…' : connected ? 'replace' : 'connect'}
            </button>
          </div>
        </form>
      </div>
    </EmberCard>
  );
}

function ConnectedPill({
  connected,
  keyLast4,
  loading,
}: {
  connected: boolean;
  keyLast4: string | null;
  loading: boolean;
}) {
  if (loading) {
    return <HeatBadge tone="dim">loading…</HeatBadge>;
  }
  if (connected) {
    // Verified + in use → warm (working heat); the key powers builds.
    return (
      <HeatBadge tone={keyStatusTone(true).badge} dot>
        connected · ••••{keyLast4 ?? '????'}
      </HeatBadge>
    );
  }
  // Missing → quiet, no heat earned.
  return <HeatBadge tone="dim">not connected</HeatBadge>;
}
