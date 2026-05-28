'use client';

// "Agent tool keys" — the connections-page section for keys the
// user's DEPLOYED AGENTS use (e.g. a Brave Search key for web_search),
// as distinct from the platform connections (GitHub/Vercel/Supabase/
// AWS) the Forge itself uses. Registry-driven: the panel set comes
// from GET /api/connections/tool-provider (which derives it from the
// engine tool registry), so a new provider-backed tool gets a panel
// with no UI change here.
//
// SECURITY:
//   - The key lives in component state only while typing; it's CLEARED
//     on submit so a re-render can't carry it.
//   - POSTed in the request body (never URL), verified before persist,
//     stored encrypted server-side. The key is NEVER pre-filled and
//     NEVER returned by any endpoint.

import { useEffect, useState, type FormEvent } from 'react';
import { GlassPanel } from '@/components/GlassPanel';

interface ToolProviderStatus {
  provider: string;
  label: string;
  env_key: string;
  setup_url: string | null;
  connected: boolean;
  connected_at: string | null;
}

export function ToolProviderKeysSection() {
  const [providers, setProviders] = useState<ToolProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [topError, setTopError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/connections/tool-provider', { method: 'GET' });
      const body = (await res.json()) as {
        providers?: ToolProviderStatus[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? 'load failed');
      setProviders(body.providers ?? []);
      setTopError(null);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }

  // No provider-backed tools registered → render nothing.
  if (!loading && providers.length === 0 && !topError) return null;

  return (
    <section className="flex flex-col gap-4" data-testid="agent-tool-keys">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
          agent tool keys
        </p>
        <p className="mt-2 max-w-2xl text-sm text-forge-dim">
          These are keys your <span className="text-forge-text">deployed agents</span>{' '}
          use to call external providers at runtime — distinct from the platform
          connections above, which the Forge itself uses to build + ship. A tool
          like <code className="text-forge-text">web_search</code> needs a provider
          key (Brave Search); connect it here and the deploy gate is satisfied. Keys
          are verified before saving, stored encrypted, and wired into the agent&apos;s
          environment server-side only.
        </p>
      </div>

      {topError ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {topError}
        </p>
      ) : null}

      {loading ? (
        <GlassPanel className="border-dashed">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            loading agent tool keys…
          </p>
        </GlassPanel>
      ) : (
        providers.map((p) => (
          <ToolProviderKeyPanel key={p.provider} status={p} onChanged={refresh} />
        ))
      )}
    </section>
  );
}

function ToolProviderKeyPanel({
  status,
  onChanged,
}: {
  status: ToolProviderStatus;
  onChanged: () => Promise<void>;
}) {
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyFailed, setVerifyFailed] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const connected = status.connected;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setVerifyFailed(null);
    setInfo(null);
    const trimmed = key.trim();
    if (trimmed.length < 8) {
      setError('Paste a real key.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        '/api/connections/tool-provider/' + encodeURIComponent(status.provider),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: trimmed }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        connected?: boolean;
        reason?: string;
        error?: string;
        status?: number | null;
      };
      // Clear the secret IMMEDIATELY — a re-render must not carry it.
      setKey('');
      if (res.status === 422 && body.reason === 'verify_failed') {
        setVerifyFailed(
          body.error ?? status.label + ' rejected the key — not saved.',
        );
        return;
      }
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setInfo('connected · key verified + stored encrypted');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'connect failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove() {
    if (!confirm('Disconnect the ' + status.label + ' key?')) return;
    setError(null);
    setVerifyFailed(null);
    setInfo(null);
    setRemoveBusy(true);
    try {
      const res = await fetch(
        '/api/connections/tool-provider/' +
          encodeURIComponent(status.provider) +
          '/disconnect',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'remove failed');
      setInfo('disconnected');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'remove failed');
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4" data-testid={'tool-provider-' + status.provider}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              {status.label}
            </p>
            <p className="mt-1 text-sm text-forge-text/90">
              Used by agent tools that call {status.label}. Wired into the
              deployed agent as{' '}
              <code className="text-forge-text">{status.env_key}</code> (server-only).
            </p>
            {status.setup_url ? (
              <a
                href={status.setup_url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan hover:text-forge-text"
              >
                get a key →
              </a>
            ) : null}
          </div>
          <ConnectedPill connected={connected} />
        </div>

        {connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
            <p className="font-mono text-[11px] text-forge-text/90">
              key stored ·{' '}
              <span className="text-forge-dim">
                {status.connected_at
                  ? new Date(status.connected_at).toLocaleString()
                  : '—'}
              </span>
            </p>
            <button
              type="button"
              onClick={onRemove}
              disabled={removeBusy}
              className="rounded-xl border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-rose-400/50 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {removeBusy ? 'removing…' : 'disconnect'}
            </button>
          </div>
        ) : null}

        {verifyFailed ? (
          <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-rose-300">
              verify failed
            </p>
            <p className="mt-1 font-mono text-[11px] text-rose-200">{verifyFailed}</p>
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
              placeholder={'paste your ' + status.label + ' API key'}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
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

          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-[10px] text-forge-dim">
              verified before save · encrypted at rest · never returned · used only
              by your deployed agent
            </p>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl border border-forge-cyan/60 bg-forge-cyan/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-cyan shadow-cyan transition hover:bg-forge-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'verifying…' : connected ? 'replace' : 'verify & save'}
            </button>
          </div>
        </form>
      </div>
    </GlassPanel>
  );
}

function ConnectedPill({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="rounded-full border border-emerald-400/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
        connected
      </span>
    );
  }
  return (
    <span className="rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
      not connected
    </span>
  );
}
