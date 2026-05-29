// Layout for the signed-in app. Mounts the persistent 3D world + the
// in-app nav header / footer. Routes under app/(app)/* (projects,
// forge, governance, settings) inherit this. The public landing at
// "/" and the auth flows at /sign-in stay outside it.

import { AppBackdrop } from '@/components/lq/AppBackdrop';
import { AppShellHeader } from '@/components/lq/AppShellHeader';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Backdrop SWITCH — AurexisAmbient for migrated routes, ForgeBackdrop
          (+ the persistent 3D ForgeScene) for everything else. See
          components/lq/AppBackdrop + lib/migrated-routes. */}
      <AppBackdrop />

      {/* Foreground DOM layer — always crisp, always accessible. */}
      <div className="relative z-10 flex min-h-screen flex-col">
        {/* Nav SWITCH — AiNav for migrated routes, the forge header
            otherwise (byte-identical to before for un-migrated pages). */}
        <AppShellHeader />

        <main className="flex flex-1 flex-col px-6 pb-12">{children}</main>
      </div>
    </>
  );
}
