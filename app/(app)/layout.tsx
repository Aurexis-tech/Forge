// Layout for the signed-in app. Mounts the persistent 3D world + the
// in-app nav header / footer. Routes under app/(app)/* (projects,
// forge, governance, settings) inherit this. The public landing at
// "/" and the auth flows at /sign-in stay outside it.

import Link from 'next/link';
import { ForgeScene } from '@/components/ForgeScene';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Persistent 3D world. Sits behind every authed route. */}
      <ForgeScene />

      {/* Foreground DOM layer — always crisp, always accessible. */}
      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-8 py-6">
          <Link
            href="/forge"
            className="group flex items-center gap-3 font-mono text-sm uppercase tracking-[0.4em] text-forge-text/90 hover:text-forge-amber"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber transition group-hover:shadow-[0_0_24px_rgba(255,154,77,0.7)]" />
            Aurexis&nbsp;Forge
          </Link>
          <nav className="flex items-center gap-6 font-mono text-xs uppercase tracking-[0.3em] text-forge-dim">
            <Link href="/forge" className="hover:text-forge-text">
              Intake
            </Link>
            <Link href="/projects" className="hover:text-forge-text">
              Projects
            </Link>
            <Link href="/settings/keys" className="hover:text-forge-cyan">
              Keys
            </Link>
            <Link href="/governance" className="hover:text-forge-amber">
              Governance
            </Link>
          </nav>
        </header>

        <main className="flex flex-1 flex-col px-6 pb-12">{children}</main>

        <footer className="px-8 pb-6 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim/60">
          v0.1 · foundation
        </footer>
      </div>
    </>
  );
}
