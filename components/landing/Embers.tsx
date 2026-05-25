'use client';

// Rising embers around the forge core. Cheap Points system — particles
// drift upward with a slight horizontal sway, re-spawn at the bottom.
// One BufferGeometry, one Points, one Material. Disposed on unmount.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface Props {
  count?: number;
  // Radius around the core that embers spawn within.
  radius?: number;
  // Vertical reach above the core where embers fade out.
  reach?: number;
}

export function Embers({ count = 90, radius = 2.4, reach = 5 }: Props) {
  const ref = useRef<THREE.Points>(null);

  const { geometry, material, lifetimes, drift } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const lifetimes = new Float32Array(count);
    const drift = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      spawn(positions, i, radius);
      lifetimes[i] = Math.random();
      drift[i] = (Math.random() - 0.5) * 0.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color('#ffb578'),
      size: 0.03,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geometry: geo, material: mat, lifetimes, drift };
  }, [count, radius]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      lifetimes[i]! += delta * 0.18;
      if (lifetimes[i]! > 1) {
        spawn(pos, i, radius);
        lifetimes[i] = 0;
        continue;
      }
      // Rise + sway.
      pos[i * 3 + 1]! += delta * 0.55;
      pos[i * 3]! += Math.sin(lifetimes[i]! * 4 + i) * delta * (drift[i] ?? 0) * 0.5;
      // Fade-out near the top is communicated by opacity ramp baked
      // into material — particles simply respawn before they reach reach.
      if (pos[i * 3 + 1]! > reach) {
        spawn(pos, i, radius);
        lifetimes[i] = 0;
      }
    }
    attr.needsUpdate = true;
  });

  return <points ref={ref} geometry={geometry} material={material} />;
}

function spawn(arr: Float32Array, i: number, radius: number) {
  const theta = Math.random() * Math.PI * 2;
  // Spawn embers in a ring around the core's base, slight inner bias.
  const r = radius * (0.5 + Math.random() * 0.6);
  arr[i * 3 + 0] = Math.cos(theta) * r;
  // Start below the core so they drift up through it.
  arr[i * 3 + 1] = -1.6 + Math.random() * 0.4;
  arr[i * 3 + 2] = Math.sin(theta) * r * 0.5;
}
