'use client';

import { GlassPanel } from '@/components/GlassPanel';

interface Props {
  projectId: string;
  // Optional flash from the OAuth callback redirect.
  errorFlash?: string | null;
}

export function ConnectGitHubPanel({ projectId, errorFlash }: Props) {
  const startUrl =
    '/api/connections/github/start?return_to=' +
    encodeURIComponent('/projects/' + projectId);

  return (
    <GlassPanel>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            ship · stage 05 · connect github
          </h2>
          <p className="mt-2 text-sm text-forge-dim">
            To create a repository and push the tested build, the Forge needs
            permission on your GitHub account. The connect flow grants
            scoped access (<code className="text-forge-text">repo</code>) and
            stores the token <span className="text-forge-text">encrypted at rest</span>;
            the plaintext token never reaches the browser.
          </p>
        </div>

        {errorFlash ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            GitHub error: {errorFlash}
          </p>
        ) : null}

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-forge-dim">
          After approving, GitHub will redirect you back to this page. Nothing
          is created on your account yet — a second human authorisation gate
          will appear before any repo is touched.
        </p>

        <div>
          <a
            href={startUrl}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25"
          >
            <span>Connect GitHub</span>
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-forge-amber shadow-amber"
            />
          </a>
        </div>
      </div>
    </GlassPanel>
  );
}
