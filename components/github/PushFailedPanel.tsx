'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { GitHubPushPanel } from './GitHubPushPanel';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  projectName: string;
  accountLogin: string;
  filesCount: number;
  errorMessage: string | null;
}

// On failure the user gets the same authorisation gate again — no silent
// retry. They must explicitly re-approve to push.
export function PushFailedPanel({
  projectId,
  projectName,
  accountLogin,
  filesCount,
  errorMessage,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [resetting, setResetting] = useState(false);

  async function onResetToTested() {
    setCoreState('working');
    setResetting(true);
    // The route only accepts authorized:true; we just refresh to re-render
    // the page. Status will already be 'push_failed'; the user can hit
    // Approve in the gate below to retry.
    router.refresh();
    setResetting(false);
    setCoreState('idle');
  }

  return (
    <div className="flex flex-col gap-4">
      <GlassPanel className="border-rose-400/40">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-rose-400"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-300">
              push · failed
            </h2>
          </div>
          {errorMessage ? (
            <pre className="whitespace-pre-wrap rounded-lg border border-rose-400/30 bg-rose-500/[0.07] p-3 font-mono text-xs text-rose-200/90">
              {errorMessage}
            </pre>
          ) : (
            <p className="text-sm text-forge-dim">
              The push attempt did not complete. You can retry by approving the
              gate below — nothing happens until you do.
            </p>
          )}
          <button
            type="button"
            onClick={onResetToTested}
            disabled={resetting}
            className="self-start rounded-xl border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-forge-cyan/50 hover:text-forge-cyan disabled:cursor-not-allowed disabled:opacity-60"
          >
            refresh status
          </button>
        </div>
      </GlassPanel>

      <GitHubPushPanel
        projectId={projectId}
        projectName={projectName}
        accountLogin={accountLogin}
        filesCount={filesCount}
      />
    </div>
  );
}
