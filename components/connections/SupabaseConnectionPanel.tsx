'use client';

// Settings UI for the Supabase Management connection — the
// credential the 'managed' DB provisioning path uses (P3-5a).
// Mirrors the GitHub/Vercel panel shape EXACTLY: password-style
// token input cleared on submit, status pill, test-connection
// button that calls a read-only verify endpoint, errors mapped by
// status, the token NEVER rendered or fetched after storage.
//
// SECURITY:
//   - Token in component state only while the user is typing; it's
//     cleared on submit so a re-render can't carry it.
//   - POSTed in the request body (never URL), never logged.
//   - Stored encrypted by /api/connections/supabase/pat via
//     lib/crypto; the response carries identity metadata only.

import { useEffect, useState, type FormEvent } from 'react';
import { GlassPanel } from '@/components/GlassPanel';

interface ProviderStatus {
  connected: boolean;
  account_login: string | null;
  scopes: string | null;
  connected_at: string | null;
}

interface TestResult {
  ok: boolean;
  account_login?: string | null;
  org_count?: number;
  error?: string;
}

export function SupabaseConnectionPanel() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [topError, setTopError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [orgLabel, setOrgLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/connections/integrations', { method: 'GET' });
      const body = (await res.json()) as {
        supabase?: ProviderStatus;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? 'load failed');
      setStatus(body.supabase ?? null);
      setTopError(null);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setTest(null);
    const trimmed = token.trim();
    if (trimmed.length < 8) {
      setError('Paste a real token.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/connections/supabase/pat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: trimmed,
          ...(orgLabel.trim() ? { org_label: orgLabel.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        account_login?: string;
      };
      // Clear the secret IMMEDIATELY whether the call succeeded or
      // failed — a re-render must not carry the token.
      setToken('');
      if (!res.ok)
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setInfo(
        'connected as ' +
          (body.account_login ?? 'unknown org') +
          ' · token stored encrypted',
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'connect failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function onTest() {
    setError(null);
    setInfo(null);
    setTest(null);
    setTestBusy(true);
    try {
      const res = await fetch('/api/connections/supabase/test', {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as TestResult & {
        error?: string;
      };
      if (res.status === 404) {
        setTest({ ok: false, error: 'no token stored — paste one below' });
        return;
      }
      setTest(body);
      if (body.ok) await refresh();
    } catch (err) {
      setTest({
        ok: false,
        error: err instanceof Error ? err.message : 'test failed',
      });
    } finally {
      setTestBusy(false);
    }
  }

  async function onRemove() {
    if (!confirm('Disconnect Supabase Management from the Forge?')) return;
    setError(null);
    setInfo(null);
    setTest(null);
    setRemoveBusy(true);
    try {
      const res = await fetch(
        '/api/connections/integrations?provider=supabase',
        { method: 'DELETE' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'remove failed');
      setInfo('disconnected');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'remove failed');
    } finally {
      setRemoveBusy(false);
    }
  }

  const connected = status?.connected ?? false;

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        {topError ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {topError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              Supabase Management
            </p>
            <p className="mt-1 text-sm text-forge-text/90">
              Enables the{' '}
              <span className="text-forge-text">managed</span> DB
              provisioning path — the Forge creates a fresh Supabase
              project on your account when a software build reaches
              P3-5a. The{' '}
              <span className="text-forge-text">bring-your-own</span> path
              doesn&apos;t need this connection (it takes URL + anon +
              service-role directly).
            </p>
          </div>
          <ConnectedPill
            connected={connected}
            login={status?.account_login ?? null}
            loading={loading}
          />
        </div>

        {connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <p className="font-mono text-[11px] text-forge-text/90">
                {status?.account_login ?? 'unknown'} · token stored
              </p>
              <p className="font-mono text-[10px] text-forge-dim">
                {status?.connected_at
                  ? new Date(status.connected_at).toLocaleString()
                  : '—'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onTest}
                disabled={testBusy}
                className="rounded-xl border border-forge-cyan/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan transition hover:bg-forge-cyan/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {testBusy ? 'testing…' : 'test connection'}
              </button>
              <button
                type="button"
                onClick={onRemove}
                disabled={removeBusy}
                className="rounded-xl border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-rose-400/50 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {removeBusy ? 'removing…' : 'disconnect'}
              </button>
            </div>
          </div>
        ) : null}

        {test ? (
          <div
            className={
              'rounded-lg border px-3 py-2 ' +
              (test.ok
                ? 'border-emerald-400/30 bg-emerald-500/[0.06]'
                : 'border-rose-400/40 bg-rose-500/10')
            }
          >
            <p
              className={
                'font-mono text-[11px] uppercase tracking-[0.3em] ' +
                (test.ok ? 'text-emerald-300' : 'text-rose-300')
              }
            >
              {test.ok ? 'test passed' : 'test failed'}
            </p>
            <p
              className={
                'mt-1 font-mono text-[11px] ' +
                (test.ok ? 'text-emerald-200' : 'text-rose-200')
              }
            >
              {test.ok
                ? (test.account_login ?? 'unknown') +
                  ' · ' +
                  (test.org_count ?? 0) +
                  ' organisation' +
                  ((test.org_count ?? 0) === 1 ? '' : 's')
                : (test.error ?? 'unknown error')}
            </p>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              {connected
                ? 'replace personal access token'
                : 'paste personal access token'}
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="paste your Supabase Management PAT"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
            <span className="font-mono text-[10px] text-forge-dim">
              Generate one at supabase.com → Account → Access Tokens. The
              Forge verifies read-only via{' '}
              <code className="text-forge-text">GET /v1/organizations</code>{' '}
              before storing — never creates a project here.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              organisation label (optional)
            </span>
            <input
              type="text"
              value={orgLabel}
              onChange={(e) => setOrgLabel(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. acme-prod · used as a display name only"
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
              encrypted at rest (AES-256-GCM) · never returned in any
              response · used only server-side
            </p>
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
    </GlassPanel>
  );
}

function ConnectedPill({
  connected,
  login,
  loading,
}: {
  connected: boolean;
  login: string | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <span className="rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        loading…
      </span>
    );
  }
  if (connected) {
    return (
      <span className="rounded-full border border-emerald-400/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
        connected · {login ?? 'unknown'}
      </span>
    );
  }
  return (
    <span className="rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
      not connected
    </span>
  );
}
