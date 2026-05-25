// Friendly "connect your key" surface shown when an action returns
// status 412 / reason 'needs_key'. Distinct from an error — it's just a
// missing-prerequisite state.

import Link from 'next/link';
import { GlassPanel } from '@/components/GlassPanel';

interface Props {
  provider: 'anthropic' | 'e2b';
  // Pre-filled return path, so the settings page can bounce you back here.
  returnTo?: string;
}

const COPY: Record<
  Props['provider'],
  { label: string; what: string }
> = {
  anthropic: {
    label: 'Anthropic',
    what:
      'spec extraction, planning, and codegen need an Anthropic API key',
  },
  e2b: {
    label: 'E2B',
    what:
      'sandbox tests and live runtimes need an E2B API key',
  },
};

export function NeedsKeyGate({ provider, returnTo }: Props) {
  const copy = COPY[provider];
  const href =
    '/settings/keys' +
    (returnTo ? '?return_to=' + encodeURIComponent(returnTo) : '');
  return (
    <GlassPanel className="border-forge-cyan/40">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-forge-cyan shadow-cyan"
          />
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
            connect your {copy.label.toLowerCase()} key
          </h3>
        </div>
        <p className="text-sm text-forge-text/90">
          The Forge runs on the keys <span className="text-forge-text">you</span>{' '}
          bring. To continue, {copy.what}. Your key is encrypted at rest and
          used only to run your own builds — we never see or log it.
        </p>
        <div className="flex items-center justify-end">
          <Link
            href={href}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25"
          >
            <span>Connect {copy.label}</span>
            <span aria-hidden>→</span>
          </Link>
        </div>
      </div>
    </GlassPanel>
  );
}
