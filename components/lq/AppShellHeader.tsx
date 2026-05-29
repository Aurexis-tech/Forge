'use client';

// AppShellHeader — the (app) nav SWITCH, sibling to AppBackdrop. Migrated
// routes get the AI-futuristic AiNav; everything else keeps the forge
// header (wordmark + the forge AppNav), byte-identical to before. Reads the
// same MIGRATED_ROUTES allowlist so the chrome flips with the backdrop.
//
// Relocating the forge header markup here (rather than leaving it inline in
// the layout) is what lets a migrated route swap its whole nav without a
// forge/AiNav double-bar — and without touching the forge AppNav component.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AppNav } from '@/components/AppNav';
import { AiNav } from '@/components/lq/AiNav';
import { isMigratedRoute } from '@/lib/migrated-routes';

export function AppShellHeader() {
  const pathname = usePathname();

  if (isMigratedRoute(pathname)) {
    return <AiNav />;
  }

  // The original forge header, verbatim.
  return (
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
  );
}
