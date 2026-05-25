'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useForgeStore, type CoreState } from '@/lib/store';

const AMBER = new THREE.Color('#ff9a4d');
const CYAN = new THREE.Color('#4fd4f0');
const KILLED_RED = new THREE.Color('#7a1f2a');

// Per-state animation profile for the Core. Each entry: target pulse speed,
// target emissive intensity, the colour mix between amber and cyan, and an
// optional override colour (used for the 'killed' deep-red dim).
const PROFILES: Record<
  CoreState,
  { speed: number; glow: number; mix: number; override?: THREE.Color }
> = {
  idle: { speed: 0.35, glow: 0.9, mix: 0.0 },
  active: { speed: 0.9, glow: 1.4, mix: 0.35 },
  thinking: { speed: 1.6, glow: 1.9, mix: 0.7 },
  working: { speed: 2.2, glow: 2.4, mix: 0.5 },
  error: { speed: 1.2, glow: 1.6, mix: 0.0 },
  killed: { speed: 0.15, glow: 0.35, mix: 0.0, override: KILLED_RED },
};

export function ForgeCore() {
  const groupRef = useRef<THREE.Group>(null);
  const wireRef = useRef<THREE.LineSegments>(null);
  const shellRef = useRef<THREE.Mesh>(null);

  const coreState = useForgeStore((s) => s.coreState);
  const profileRef = useRef(PROFILES.idle);

  useEffect(() => {
    profileRef.current = PROFILES[coreState] ?? PROFILES.idle;
  }, [coreState]);

  const wireGeometry = useMemo(
    () => new THREE.IcosahedronGeometry(1.2, 1),
    [],
  );
  const edgesGeometry = useMemo(
    () => new THREE.EdgesGeometry(wireGeometry),
    [wireGeometry],
  );
  const shellGeometry = useMemo(
    () => new THREE.IcosahedronGeometry(1.0, 2),
    [],
  );

  const wireMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: AMBER.clone(),
        transparent: true,
        opacity: 0.85,
        linewidth: 1,
      }),
    [],
  );

  const shellMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#1a1208'),
        emissive: AMBER.clone(),
        emissiveIntensity: 0.9,
        roughness: 0.35,
        metalness: 0.4,
        transparent: true,
        opacity: 0.55,
      }),
    [],
  );

  // Cleanup geometries and materials so route changes don't leak.
  useEffect(() => {
    return () => {
      wireGeometry.dispose();
      edgesGeometry.dispose();
      shellGeometry.dispose();
      wireMaterial.dispose();
      shellMaterial.dispose();
    };
  }, [
    wireGeometry,
    edgesGeometry,
    shellGeometry,
    wireMaterial,
    shellMaterial,
  ]);

  const tmpColor = useMemo(() => new THREE.Color(), []);
  const smoothed = useRef({ speed: 0.35, glow: 0.9, mix: 0.0 });

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();
    const target = profileRef.current;

    // Smooth the profile so transitions between states are graceful.
    const ease = 1 - Math.exp(-delta * 3);
    smoothed.current.speed += (target.speed - smoothed.current.speed) * ease;
    smoothed.current.glow += (target.glow - smoothed.current.glow) * ease;
    smoothed.current.mix += (target.mix - smoothed.current.mix) * ease;

    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.12;
      groupRef.current.rotation.x =
        Math.sin(t * 0.18) * 0.12 + state.pointer.y * 0.08;
      groupRef.current.rotation.z = state.pointer.x * 0.05;
    }

    const pulse = 0.5 + 0.5 * Math.sin(t * smoothed.current.speed * Math.PI);
    const intensity = smoothed.current.glow * (0.75 + pulse * 0.5);

    if (target.override) {
      // 'killed' mode bypasses the amber↔cyan mix entirely.
      tmpColor.copy(target.override);
    } else {
      tmpColor.copy(AMBER).lerp(CYAN, smoothed.current.mix);
    }

    if (shellMaterial) {
      shellMaterial.emissive.copy(tmpColor);
      shellMaterial.emissiveIntensity = intensity;
    }
    if (wireMaterial) {
      wireMaterial.color.copy(tmpColor);
      wireMaterial.opacity = 0.65 + pulse * 0.3;
    }
    if (shellRef.current) {
      const s = 1 + pulse * 0.04;
      shellRef.current.scale.setScalar(s);
    }
  });

  return (
    <group ref={groupRef}>
      <mesh ref={shellRef} geometry={shellGeometry} material={shellMaterial} />
      <lineSegments
        ref={wireRef}
        geometry={edgesGeometry}
        material={wireMaterial}
      />
      <pointLight color={AMBER} intensity={2.2} distance={8} decay={2} />
    </group>
  );
}
