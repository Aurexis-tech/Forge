'use client';

// Two-track connect UI: OAuth integration (preferred) when configured,
// PAT paste fallback otherwise. The PAT field is type=password and never
// stored client-side beyond its single POST.

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { GlassPanel } from '@/components/GlassPanel';

interface Props {
  projectId: string;
  oauthAvailable: boolean;
  errorFlash?: string | null;
}

export function ConnectVercelPanel({
  projectId,
  oauthAvailable,
  errorFlash,
}: Props) {
  const router = useRouter();
  const [pat, setPat] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(errorFlash ?? null);

  const startUrl =
    '/api/connections/vercel/start?return_to=' +
    encodeURIComponent('/projects/' + projectId);

  async function onSubmitPat(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = pat.trim();
    if (!trimmed) {
      setError('Paste your Vercel Personal Access Token first.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/connections/vercel/pat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setPat(''); // clear input immediately on success
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed.');
      setSubmitting(false);
    }
  }

  return (
    <GlassPanel>
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            ship · stage 06 · connect vercel
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            To deploy a live URL, the Forge needs permission on your Vercel
            account. The token is encrypted at rest and{' '}
            <span className="text-forge-text">never sent back to the browser</span>{' '}
            or written to logs.
          </p>
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            Vercel error: {error}
          </p>
        ) : null}

        {oauthAvailable ? (
          <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
              recommended · oauth integration
            </p>
            <p className="text-sm text-forge-dim">
              Install the Aurexis Forge integration on your Vercel account or
              team. You can revoke it at any time from your Vercel settings.
            </p>
            <div>
              <a
                href={startUrl}
                className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25"
              >
                <span>Install on Vercel</span>
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full bg-forge-amber shadow-amber"
                />
              </a>
            </div>
          </div>
        ) : null}

        <form
          onSubmit={onSubmitPat}
          className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-4"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-cyan">
            {oauthAvailable ? 'fallback · ' : ''}personal access token
          </p>
          <p className="text-sm text-forge-dim">
            Create a token at{' '}
            <a
              href="https://vercel.com/account/tokens"
              target="_blank"
              rel="noreferrer noopener"
              className="text-forge-amber hover:underline"
            >
              vercel.com/account/tokens
            </a>
            {' '}with the default scope (Full Account).
          </p>
          <input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            disabled={submitting}
            placeholder="paste token"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
          />
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl border border-forge-cyan/60 bg-forge-cyan/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-cyan shadow-cyan transition hover:bg-forge-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Verifying…' : 'Connect with token'}
            </button>
          </div>
        </form>

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-forge-dim">
          A second human authorisation gate appears before any deployment is
          created. Connecting alone does not deploy anything.
        </p>
      </div>
    </GlassPanel>
  );
}
