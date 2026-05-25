'use client';

// The forged-card reveal at the end of the scripted demo. Pure cosmetic
// — the URL is a placeholder, the pulse is decorative, no fetches fire.

import type { TypewriterPrompt } from './Typewriter';

const TYPE_TONE: Record<TypewriterPrompt['type'], string> = {
  Agent: 'border-forge-amber/50 text-forge-amber',
  System: 'border-forge-cyan/50 text-forge-cyan',
  Software: 'border-emerald-400/50 text-emerald-300',
  Infrastructure: 'border-amber-200/50 text-amber-200',
};

const FAUX_HOSTS: Record<TypewriterPrompt['type'], string> = {
  Agent: 'agent-arxiv-brief.forge.dev',
  System: 'system-standup-digest.forge.dev',
  Software: 'app-recipe-vault.forge.dev',
  Infrastructure: 'infra-edge-cron.forge.dev',
};

interface Props {
  type: TypewriterPrompt['type'];
  // Driven by the demo sequence — the card mounts when this flips true.
  visible: boolean;
}

export function LiveAgentCard({ type, visible }: Props) {
  if (!visible) return null;
  return (
    <div
      // keyed by type so re-running the demo with a different prompt
      // re-triggers the rise animation cleanly.
      key={type}
      className="forge-card-rise mx-auto mt-8 w-full max-w-xl rounded-2xl border border-forge-amber/30 bg-black/55 p-5 shadow-amber backdrop-blur-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.7)]"
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-emerald-300">
            live
          </span>
        </div>
        <span
          className={
            'rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] ' +
            TYPE_TONE[type]
          }
        >
          {type}
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          deployed at
        </p>
        <p className="break-all font-mono text-base text-forge-amber">
          https://{FAUX_HOSTS[type]}
        </p>
      </div>

      <p className="mt-4 text-xs text-forge-dim">
        Demo only — anonymous visitors see a scripted forge. Sign in to
        forge for real.
      </p>
    </div>
  );
}
