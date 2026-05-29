// Public landing at "/". MIGRATED to the AI-futuristic design language:
// AurexisAmbient backdrop (mounted HERE, scoped to this route — the (app)
// pages keep ForgeBackdrop untouched), the new AiNav, LiquidGlass surfaces,
// lq.* tokens, Inter (--font-ui) + JetBrains Mono (--font-code). NO API or
// engine calls fire — the demo is a scripted, self-running cycle.

import Link from 'next/link';
import { AiNav } from '@/components/lq/AiNav';
import { AurexisAmbient } from '@/components/lq/AurexisAmbient';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { LiveDemo } from '@/components/landing-ai/LiveDemo';
import { MoldShowcase } from '@/components/landing-ai/MoldShowcase';

export const metadata = {
  title: 'Aurexis Forge — describe it, it builds itself',
  description:
    'From a sentence to a running thing — agents, systems, full apps, infrastructure. Every irreversible step still waits on your yes.',
};

export default function LandingPage() {
  return (
    <>
      {/* Scoped backdrop: AurexisAmbient lives on the Landing route only.
          The (app) routes keep ForgeBackdrop (untouched). */}
      <AurexisAmbient />

      <div className="relative z-10 flex min-h-screen flex-col font-ui text-lq-ink">
        <AiNav />

        {/* HERO + LIVE DEMO — side-by-side on desktop, stacked on narrow. */}
        <section className="mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-12 px-6 py-16 sm:px-10 lg:grid-cols-2 lg:gap-10 lg:py-24">
          {/* Hero (left). */}
          <div className="flex flex-col">
            <div className="flex items-center gap-3">
              <span className="font-code text-[11px] uppercase tracking-[0.35em] text-lq-aurora">
                AI · Autonomous · Zero-code
              </span>
              <span
                aria-hidden
                className="h-px w-12 bg-gradient-to-r from-lq-aurora to-transparent"
              />
            </div>

            <h1 className="mt-6 font-ui text-5xl font-extrabold leading-[0.95] tracking-[-0.03em] text-lq-ink sm:text-7xl xl:text-[88px]">
              Builds itself.
              <br />
              <span className="text-lq-ink-faint">Asks before it ships.</span>
            </h1>

            <p className="mt-7 max-w-xl text-lg leading-relaxed text-lq-ink-dim">
              From a sentence to a running thing — agents, systems, full apps,
              infrastructure. Every irreversible step still waits on your yes.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-4">
              <LiquidGlass
                as="a"
                href="/forge"
                variant="aurora"
                className="inline-flex items-center rounded-[14px] px-6 py-4 text-[15px] font-semibold"
              >
                Start a forge →
              </LiquidGlass>
              <LiquidGlass
                as="a"
                href="#molds"
                variant="default"
                className="inline-flex items-center rounded-[14px] px-6 py-4 text-[15px] font-medium text-lq-ink"
              >
                See examples
              </LiquidGlass>
              <span className="font-code text-[12px] uppercase tracking-[0.2em] text-lq-ink-faint">
                $5 first run · BYOK
              </span>
            </div>
          </div>

          {/* Live demo (right). */}
          <div className="w-full">
            <LiveDemo />
          </div>
        </section>

        {/* Mold showcase. */}
        <MoldShowcase />

        {/* Quiet footer. */}
        <footer className="mx-auto w-full max-w-7xl px-6 py-10 sm:px-10">
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-lq-line pt-6 font-code text-[11px] uppercase tracking-[0.3em] text-lq-ink-faint">
            <span>Aurexis Forge</span>
            <div className="flex items-center gap-6">
              <Link href="/sign-in" className="transition-colors hover:text-lq-ink">
                Sign in
              </Link>
              <span>Built in the open</span>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
