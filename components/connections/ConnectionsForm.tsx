'use client';

// Settings UI for GitHub + Vercel integrations. Mirrors the visual shape
// of KeysForm so /settings/keys and /settings/connections feel like one
// product. Pure DOM — masked token input, connected-state pill, "Test
// connection" button. NEVER renders or fetches the stored token.

import { useEffect, useState, type FormEvent } from 'react';
import { GlassPanel } from '@/components/GlassPanel';

type Provider = 'github' | 'vercel';

interface ProviderStatus {
  connected: boolean;
  account_login: string | null;
  scopes: string | null;
  connected_at: string | null;
}

interface StatusResponse {
  github: ProviderStatus;
  vercel: ProviderStatus;
}

interface TestResult {
  ok: boolean;
  account_login?: string | null;
  scopes?: string | null;
  email?: string | null;
  error?: string;
}

interface CardCopy {
  label: string;
  blurb: string;
  hint: string;
  // Path the user can hit to start an OAuth flow if it's configured. The
  // PAT path is always available as the fallback.
  oauthHref: string | null;
  oauthLabel: string;
  patTokenHint: string;
}

const COPY: Record<Provider, CardCopy> = {
  github: {
    label: 'GitHub',
    blurb:
      'Used to push generated builds into a private repo on your account.',
    hint:
      "Either click 'Connect via OAuth' (uses our GitHub App) or paste a Personal Access Token with 'repo' scope (or fine-grained Administration + Contents).",
    oauthHref: '/api/connections/github/start?return_to=/settings/connections',
    oauthLabel: 'Connect via OAuth',
    patTokenHint:
      'Generate one at github.com → Settings → Developer settings → Personal access tokens.',
  },
  vercel: {
    label: 'Vercel',
    blurb: 'Used to create a project and deploy the built repo on your account.',
    hint:
      "Either install our Vercel integration or paste a Personal Access Token (Account → Tokens).",
    oauthHref: '/api/connections/vercel/start?return_to=/settings/connections',
    oauthLabel: 'Install integration',
    patTokenHint:
      'Generate one at vercel.com → Account Settings → Tokens (scope: full account).',
  },
};

export function ConnectionsForm() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/connections/integrations', { method: 'GET' });
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

      <GlassPanel>
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            why integrations live here
          </p>
          <p className="text-sm text-forge-text/90">
            Tokens are encrypted at rest (AES-256-GCM) and only ever used
            server-side to push <span className="text-forge-text">your own</span>{' '}
            builds + deployments.{' '}
            <span className="text-forge-text">We never see or log them</span>
            ; the UI only ever shows that a token is stored.
          </p>
        </div>
      </GlassPanel>

      <ProviderCard
        provider="github"
        status={status?.github ?? null}
        loading={loading}
        onChanged={refresh}
      />
      <ProviderCard
        provider="vercel"
        status={status?.vercel ?? null}
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
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  const connected = status?.connected ?? false;

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
      const res = await fetch('/api/connections/' + provider + '/pat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        account_login?: string;
      };
      if (!res.ok)
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setToken('');
      setInfo(
        'connected as ' + (body.account_login ?? 'unknown') + ' · token stored',
      );
      await onChanged();
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
      const res = await fetch('/api/connections/' + provider + '/test', {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as TestResult & {
        error?: string;
      };
      // 404 means no connection — surface it as a test failure.
      if (res.status === 404) {
        setTest({ ok: false, error: 'no token stored — paste one below' });
        return;
      }
      setTest(body);
      if (body.ok) await onChanged();
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
    if (!confirm('Disconnect ' + copy.label + ' from the Forge?')) return;
    setError(null);
    setInfo(null);
    setTest(null);
    setRemoveBusy(true);
    try {
      const res = await fetch(
        '/api/connections/integrations?provider=' + provider,
        { method: 'DELETE' },
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
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              {copy.label}
            </p>
            <p className="mt-1 text-sm text-forge-text/90">{copy.blurb}</p>
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
                {status?.scopes ? 'scopes: ' + status.scopes + ' · ' : ''}
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
          <TestPanel test={test} provider={provider} />
        ) : null}

        {copy.oauthHref ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
            <p className="font-mono text-[11px] text-forge-text/80">
              prefer OAuth?
            </p>
            <a
              href={copy.oauthHref}
              className="rounded-xl border border-forge-amber/50 bg-forge-amber/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber transition hover:bg-forge-amber/20"
            >
              {copy.oauthLabel}
            </a>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              {connected ? 'replace token' : 'paste token'}
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={'paste your ' + copy.label + ' token'}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
            <span className="font-mono text-[10px] text-forge-dim">
              {copy.patTokenHint}
            </span>
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
            <p className="font-mono text-[10px] text-forge-dim">{copy.hint}</p>
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

function TestPanel({
  test,
  provider,
}: {
  test: TestResult;
  provider: Provider;
}) {
  if (test.ok) {
    const identity = test.account_login ?? 'unknown';
    const subtitle = (() => {
      if (provider === 'github') {
        const scopeNote = test.scopes
          ? 'scopes: ' + test.scopes
          : 'no scope header returned';
        const hasRepo = test.scopes
          ? /\b(repo|administration|contents)\b/i.test(test.scopes)
          : false;
        return scopeNote + (hasRepo ? '' : ' · ⚠️ no repo / fine-grained scope detected');
      }
      return test.email ? 'email: ' + test.email : 'email not returned';
    })();
    return (
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/[0.06] px-3 py-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-300">
          test passed
        </p>
        <p className="mt-1 font-mono text-[11px] text-emerald-200">
          {identity} · {subtitle}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-rose-300">
        test failed
      </p>
      <p className="mt-1 font-mono text-[11px] text-rose-200">
        {test.error ?? 'unknown error'}
      </p>
    </div>
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
