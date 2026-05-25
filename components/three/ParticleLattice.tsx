'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useForgeStore } from '@/lib/store';

interface ParticleLatticeProps {
  // Override count for small viewports / low-power devices.
  count?: number;
}

export function ParticleLattice({ count = 1400 }: ParticleLatticeProps) {
  const pointsRef = useRef<THREE.Points>(null);
  const coreState = useForgeStore((s) => s.coreState);

  const { geometry, material } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const offsets = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // Distribute around a thick shell so the Core sits inside a lattice.
      const r = 2.4 + Math.random() * 3.6;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);

      offsets[i] = Math.random() * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 1));

    const mat = new THREE.PointsMaterial({
      color: new THREE.Color('#4fd4f0'),
      size: 0.04,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    return { geometry: geo, material: mat };
  }, [count]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame((state, delta) => {
    if (!pointsRef.current) return;
    const speed =
      coreState === 'thinking' || coreState === 'working' ? 0.18 : 0.06;
    pointsRef.current.rotation.y += delta * speed;
    pointsRef.current.rotation.x += delta * speed * 0.4;

    // Subtle breathing on the whole lattice.
    const t = state.clock.getElapsedTime();
    const breathe = 1 + Math.sin(t * 0.5) * 0.015;
    pointsRef.current.scale.setScalar(breathe);
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}
