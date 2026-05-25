'use client';

// The actual three.js Canvas. Lazy-loaded by ForgeScene via next/dynamic so
// the heavy 3D dependencies never ship to fallback users and never run on the
// server.

import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { ForgeCore } from './three/ForgeCore';
import { JourneyPipeline } from './three/JourneyPipeline';
import { ParticleLattice } from './three/ParticleLattice';
import { PostFX } from './three/PostFX';
import { useForgeStore, type ActiveJourneySnapshot } from '@/lib/store';
import type { Journey } from '@/lib/journey';
import { isSmallViewport } from '@/lib/webgl';

export default function ForgeWorld() {
  const [small, setSmall] = useState(false);

  useEffect(() => {
    setSmall(isSmallViewport());
    const onResize = () => setSmall(isSmallViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Pause the render loop when the tab is hidden — eliminates background
  // GPU churn while the user is on another tab.
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const snapshot = useForgeStore((s) => s.activeJourney);
  const journey = useMemo(
    () => (snapshot ? snapshotToJourney(snapshot) : null),
    [snapshot],
  );

  return (
    <div className="pointer-events-none fixed inset-0 -z-10">
      <Canvas
        camera={{ position: [0, 0, 6.5], fov: 55, near: 0.1, far: 100 }}
        dpr={[1, 2]}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
        }}
        frameloop={visible ? 'always' : 'never'}
        onCreated={({ scene, gl }) => {
          scene.background = null;
          gl.setClearColor('#05060a', 1);
        }}
      >
        <ambientLight intensity={0.18} />
        <directionalLight position={[5, 6, 4]} intensity={0.55} />
        <Suspense fallback={null}>
          <ForgeCore />
          <ParticleLattice count={small ? 600 : 1400} />
          {journey ? (
            <JourneyPipeline
              journey={journey}
              particles={small ? 60 : 120}
              offset={[0, -2.3, 0]}
            />
          ) : null}
        </Suspense>
        <PostFX enableBloom={!small} />
      </Canvas>
    </div>
  );
}

// Reconstruct a Journey-shaped object from the lightweight store snapshot.
// The JourneyPipeline only reads `stages` and `cursor.id`, so we don't need
// to round-trip through the full deriveJourney logic.
function snapshotToJourney(snap: ActiveJourneySnapshot): Journey {
  const cursor =
    snap.stages.find((s) => s.id === snap.cursorId) ?? snap.stages[0]!;
  return {
    stages: snap.stages.map((s) => ({
      id: s.id as Journey['stages'][number]['id'],
      index: s.index,
      label: s.label,
      detail: s.detail,
      status: s.status,
    })),
    cursor: {
      id: cursor.id as Journey['stages'][number]['id'],
      index: cursor.index,
      label: cursor.label,
      detail: cursor.detail,
      status: cursor.status,
    },
    isLive: snap.isLive,
    isRuntimeMode: false,
  };
}
