'use client';

// AppBackdrop — the (app) backdrop SWITCH. Reads the current route and
// renders the AI-futuristic AurexisAmbient for MIGRATED routes, or the
// forge backdrop (ForgeBackdrop + the persistent 3D ForgeScene) for
// everything else (the default during the transition). Mounted once in
// app/(app)/layout.tsx in place of the old direct ForgeBackdrop mount.
//
// This centralizes the transitional state: a future (app) page migration
// just adds its route to MIGRATED_ROUTES; the final cleanup prompt deletes
// this switch and ForgeBackdrop. AurexisAmbient is the single aurora
// backdrop — never double-mounted with ForgeBackdrop.

import { usePathname } from 'next/navigation';
import { ForgeBackdrop } from '@/components/ForgeBackdrop';
import { ForgeScene } from '@/components/ForgeScene';
import { isMigratedRoute } from '@/lib/migrated-routes';

export function AppBackdrop() {
  const pathname = usePathname();
  if (isMigratedRoute(pathname)) {
    // Migrated routes defer to the global ConstellationBackground (mounted in
    // app/layout.tsx) — render nothing here so it shows through.
    return null;
  }
  return (
    <>
      <ForgeBackdrop />
      <ForgeScene />
    </>
  );
}
