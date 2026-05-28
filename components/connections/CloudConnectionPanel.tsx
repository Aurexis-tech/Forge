'use client';

// Settings UI for the AWS cloud-credentials connection — the
// credential the P4-5a real-plan + P4-5b apply routes use.
// Mirrors the GitHub/Vercel panel shape, but with THREE inputs
// (access key id + secret + region) since AWS needs all three.
//
// SECURITY:
//   - All three values live in component state only while the user
//     is typing. They are CLEARED on submit (success or failure) so a
//     re-render can't carry them.
//   - POSTed in the request body (never URL), never logged.
//   - Stored as ONE encrypted JSON env bag by /api/connections/cloud/pat
//     via lib/crypto. The response contains the AWS account id + ARN
//     only — non-secrets.
//
// ⚠️ STRONG GUIDANCE — rendered prominently, not fine-print:
//   - Use a DEDICATED, LEAST-PRIVILEGE IAM USER. Never paste root
//     account keys.
//   - Set an AWS Budget + billing alarm as a backstop. The Forge's
//     in-app cost ceiling blocks BEFORE apply; an AWS-side budget is
//     the second line of defence.

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
  aws_account_id?: string | null;
  aws_caller_arn?: string | null;
  aws_region?: string | null;
  error?: string;
}

const DEFAULT_REGION = 'us-east-1';

export function CloudConnectionPanel() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [topError, setTopError] = useState<string | null>(null);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState(DEFAULT_REGION);
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
        cloud?: ProviderStatus;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? 'load failed');
      setStatus(body.cloud ?? null);
      setTopError(null);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }

  function clearAllSecrets() {
    setAccessKeyId('');
    setSecretAccessKey('');
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setTest(null);
    const ak = accessKeyId.trim();
    const sk = secretAccessKey.trim();
    const r = region.trim();
    if (!ak || !sk || !r) {
      setError('All three fields are required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/connections/cloud/pat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          AWS_ACCESS_KEY_ID: ak,
          AWS_SECRET_ACCESS_KEY: sk,
          AWS_REGION: r,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        account_login?: string;
        aws_account_id?: string;
        aws_caller_arn?: string;
      };
      // CLEAR secrets immediately, whether the call succeeded or not.
      clearAllSecrets();
      if (!res.ok)
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setInfo(
        'connected as ' +
          (body.account_login ?? 'unknown') +
          ' · arn ' +
          (body.aws_caller_arn ?? 'unknown') +
          ' · credentials encrypted at rest',
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
      const res = await fetch('/api/connections/cloud/test', {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as TestResult & {
        error?: string;
      };
      if (res.status === 404) {
        setTest({
          ok: false,
          error: 'no credentials stored — paste a key pair below',
        });
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
    if (!confirm('Disconnect cloud credentials from the Forge?')) return;
    setError(null);
    setInfo(null);
    setTest(null);
    setRemoveBusy(true);
    try {
      const res = await fetch(
        '/api/connections/integrations?provider=cloud',
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
              Cloud credentials (AWS)
            </p>
            <p className="mt-1 text-sm text-forge-text/90">
              The credential the Phase 4 real plan + apply paths use.
              READ-ONLY verified via AWS STS GetCallerIdentity before
              persisting. The Forge applies ONLY the vetted module
              catalog (P4-3); even so —
            </p>
          </div>
          <ConnectedPill
            connected={connected}
            login={status?.account_login ?? null}
            loading={loading}
          />
        </div>

        {/* --- Strong guidance — prominent, not fine-print. -------- */}
        <div className="rounded-lg border border-forge-amber/50 bg-forge-amber/10 p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
            strongly recommended · before you paste
          </p>
          <ul className="mt-2 flex flex-col gap-2 text-sm text-forge-text/90">
            <li>
              <span className="text-forge-amber">→</span>{' '}
              <span className="text-forge-text">
                Use a dedicated, least-privilege IAM user.
              </span>{' '}
              NEVER paste root account keys. Create an IAM user with only
              the policies the catalog modules need (VPC, RDS, S3, SQS,
              ECS / Fargate, Lambda, CloudWatch, IAM-create for service
              identities).
            </li>
            <li>
              <span className="text-forge-amber">→</span>{' '}
              <span className="text-forge-text">
                Set an AWS Budget + billing alarm.
              </span>{' '}
              The Forge&apos;s in-app cost ceiling blocks before apply
              (P4-4) and again on the real plan (P4-5a). An AWS-side
              budget is the second line of defence — Console → Billing
              → Budgets.
            </li>
            <li>
              <span className="text-forge-amber">→</span>{' '}
              <span className="text-forge-text">
                Rotate on a schedule.
              </span>{' '}
              These keys land encrypted in the Forge, but treat them
              like every other long-lived credential.
            </li>
          </ul>
        </div>

        {connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <p className="font-mono text-[11px] text-forge-text/90">
                {status?.account_login ?? 'unknown'} · credentials stored
              </p>
              <p className="font-mono text-[10px] text-forge-dim">
                {status?.scopes ? 'arn: ' + status.scopes + ' · ' : ''}
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
                  ' · arn ' +
                  (test.aws_caller_arn ?? 'unknown')
                : (test.error ?? 'unknown error')}
            </p>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              AWS_ACCESS_KEY_ID
            </span>
            <input
              type="password"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="AKIA… (IAM user, not root)"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              AWS_SECRET_ACCESS_KEY
            </span>
            <input
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="paste the secret access key"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              AWS_REGION
            </span>
            <input
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={DEFAULT_REGION}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
            />
            <span className="font-mono text-[10px] text-forge-dim">
              The Forge verifies via AWS STS GetCallerIdentity (read-only,
              free) before storing. NEVER creates / modifies anything
              during the verify.
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
            <p className="font-mono text-[10px] text-forge-dim">
              encrypted at rest (AES-256-GCM) · never returned in any
              response · used only server-side for terraform plan / apply
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
