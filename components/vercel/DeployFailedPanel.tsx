'use client';

import { GlassPanel } from '@/components/GlassPanel';
import { DeployFlow } from './DeployFlow';
import type { BuildPlan } from '@/lib/engine/planner/schema';

interface Props {
  projectId: string;
  projectName: string;
  accountLogin: string;
  filesCount: number;
  envRequired: BuildPlan['env_required'];
  framework: string;
  errorMessage: string | null;
  logTail: string | null;
}

// On failure the user gets the same flow again — no silent retry. Secrets
// must be re-entered, then the gate must be re-approved.
export function DeployFailedPanel({
  projectId,
  projectName,
  accountLogin,
  filesCount,
  envRequired,
  framework,
  errorMessage,
  logTail,
}: Props) {
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
              deploy · failed
            </h2>
          </div>
          {errorMessage ? (
            <pre className="whitespace-pre-wrap rounded-lg border border-rose-400/30 bg-rose-500/[0.07] p-3 font-mono text-xs text-rose-200/90">
              {errorMessage}
            </pre>
          ) : null}
          {logTail ? (
            <div className="rounded-lg border border-white/10 bg-black/60 p-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                vercel build log · tail
              </p>
              <pre className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-forge-text/90">
                {logTail}
              </pre>
            </div>
          ) : null}
          <p className="text-sm text-forge-dim">
            Retry below — the deploy needs the secrets again and explicit
            re-authorisation. Nothing happens until you approve.
          </p>
        </div>
      </GlassPanel>

      <DeployFlow
        projectId={projectId}
        projectName={projectName}
        accountLogin={accountLogin}
        filesCount={filesCount}
        envRequired={envRequired}
        framework={framework}
      />
    </div>
  );
}
