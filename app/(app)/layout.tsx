// Layout for the signed-in app. Mounts the persistent 3D world + the
// in-app nav header / footer. Routes under app/(app)/* (projects,
// forge, governance, settings) inherit this. The public landing at
// "/" and the auth flows at /sign-in stay outside it.

import Link from 'next/link';
import { ForgeBackdrop } from '@/components/ForgeBackdrop';
import { ForgeScene } from '@/components/ForgeScene';
import { AppNav } from '@/components/AppNav';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Shared atmosphere — CSS lattice + breathing glow + rising embers +
          vignette behind every authed route, so every page carries the
          forge's world even when the 3D scene is in fallback. */}
      <ForgeBackdrop />

      {/* Persistent 3D world. Sits above the ambient layer, below content. */}
      <ForgeScene />

      {/* Foreground DOM layer — always crisp, always accessible. */}
      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="flex flex-wrap items-center justify-between gap-4 px-8 py-6">
          <Link
            href="/forge"
            className="group flex items-center gap-3 font-mono text-sm uppercase tracking-[0.4em] text-forge-text/90 hover:text-forge-amber"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber transition group-hover:shadow-[0_0_24px_rgba(255,154,77,0.7)]" />
            Aurexis&nbsp;Forge
          </Link>
          <AppNav />
        </header>

        <main className="flex flex-1 flex-col px-6 pb-12">{children}</main>
      </div>
    </>
  );
}
