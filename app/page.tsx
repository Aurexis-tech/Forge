// Public landing at "/". Middleware redirects authenticated users away,
// so by the time this renders the visitor is guaranteed to be logged
// out. NO API or engine calls fire — the hero is a scripted demo.

import Link from 'next/link';
import { LandingHero } from '@/components/landing/LandingHero';
import {
  CtaBand,
  FourThings,
  HowItWorks,
  LandingFooter,
  OneExample,
  TrustLine,
} from '@/components/landing/Sections';

export const metadata = {
  title: 'Aurexis Forge — describe it, the Forge builds it',
  description:
    'A workshop that turns plain-language ideas into live agents. Bring your own key; nothing ships until you approve.',
};

export default function LandingPage() {
  return (
    <div className="relative isolate min-h-screen bg-forge-void">
      {/* Minimal public top-bar — just the wordmark + a sign-in shortcut.
          No in-app nav, no ForgeScene canvas behind it; the hero has its
          own canvas. */}
      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-6 py-5 sm:px-10">
        <Link
          href="/"
          className="group flex items-center gap-3 font-mono text-sm uppercase tracking-[0.4em] text-forge-text/90 hover:text-forge-amber"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber transition group-hover:shadow-[0_0_24px_rgba(255,154,77,0.7)]" />
          Aurexis&nbsp;Forge
        </Link>
        <Link
          href="/sign-in"
          className="rounded-full border border-white/15 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim transition hover:border-forge-amber/50 hover:text-forge-amber"
        >
          sign in
        </Link>
      </header>

      <LandingHero />
      <HowItWorks />
      <FourThings />
      <TrustLine />
      <OneExample />
      <CtaBand />
      <LandingFooter />
    </div>
  );
}
