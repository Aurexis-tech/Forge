'use client';

// The oversized hero canvas for the public landing. Reuses ForgeCore +
// PostFX from the app shell, adds rising embers, sits behind the hero
// content. Lazy-mounted via next/dynamic on the LandingHero side so the
// WebGL bundle never reaches WebGL-off users.

import { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { ForgeCore } from '@/components/three/ForgeCore';
import { PostFX } from '@/components/three/PostFX';
import { Embers } from './Embers';
import { isSmallViewport } from '@/lib/webgl';

export default function HeroCanvas() {
  const [small, setSmall] = useState(false);

  useEffect(() => {
    setSmall(isSmallViewport());
    const onResize = () => setSmall(isSmallViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0">
      <Canvas
        // Pulled back slightly + slightly elevated so the core sits a
        // touch above centre and the embers + aurora frame it.
        camera={{ position: [0, 0.25, 5.6], fov: 50, near: 0.1, far: 100 }}
        dpr={[1, 2]}
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance',
        }}
        frameloop={visible ? 'always' : 'never'}
        onCreated={({ scene, gl }) => {
          scene.background = null;
          gl.setClearColor('#05060a', 0);
        }}
      >
        <ambientLight intensity={0.2} />
        <directionalLight position={[3, 5, 2]} intensity={0.55} />
        <Suspense fallback={null}>
          {/* Bigger core for the landing: scale group + lifts a hair. */}
          <group scale={small ? 1.45 : 1.7} position={[0, 0.1, 0]}>
            <ForgeCore />
          </group>
          <Embers count={small ? 50 : 110} radius={2.6} reach={5.5} />
        </Suspense>
        <PostFX enableBloom={!small} />
      </Canvas>
    </div>
  );
}
