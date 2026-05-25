'use client';

// The persistent world wrapper. Lives at the root of the app layout so it
// never unmounts between routes — the camera, Core, and lattice keep their
// state as the user navigates.

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useForgeStore } from '@/lib/store';
import { detectWebGL, prefersReducedMotion } from '@/lib/webgl';
import { FallbackShell } from './FallbackShell';

// Lazy-load the 3D layer client-side only. Keeps three.js out of the SSR
// bundle and out of the bundle entirely for fallback users.
const ForgeWorld = dynamic(() => import('./ForgeWorld'), {
  ssr: false,
  loading: () => <ForgeLoadingShell />,
});

function ForgeLoadingShell() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 grid place-items-center bg-forge-void">
      <div className="flex items-center gap-3 text-forge-dim">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-forge-amber shadow-amber" />
        <span className="font-mono text-xs uppercase tracking-[0.3em]">
          igniting the forge
        </span>
      </div>
    </div>
  );
}

export function ForgeScene() {
  const setWebglReady = useForgeStore((s) => s.setWebglReady);
  const [mode, setMode] = useState<'pending' | '3d' | 'fallback'>('pending');

  useEffect(() => {
    const ok = detectWebGL() && !prefersReducedMotion();
    setWebglReady(ok);
    setMode(ok ? '3d' : 'fallback');
  }, [setWebglReady]);

  if (mode === 'pending') return <ForgeLoadingShell />;
  if (mode === 'fallback') return <FallbackShell />;
  return <ForgeWorld />;
}
