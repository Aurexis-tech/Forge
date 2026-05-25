'use client';

// The 3D pipeline: 8 stage-nodes strung along a horizontal conduit fed by
// the molten Forge Core off-screen. Each node's material reflects its
// JourneyStage status:
//
//   done    → solid amber, steady glow
//   current → cyan, pulsing in time with the Core's 'working' state
//   pending → very dim grey, no glow
//   failed  → rose red, occasional flare
//   skipped → ghosted amber outline (e.g. runtime mode skips deploy)
//   blocked → muted amber waiting for the previous stage
//
// Particles flow along the conduit toward the cursor node to convey
// "energy in motion". Particle count is capped on small viewports.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Journey, JourneyStageStatus } from '@/lib/journey';

interface Props {
  journey: Journey;
  // How many flow particles to spawn. Caller passes a small number on
  // mobile.
  particles?: number;
  // Offset so the pipeline sits beside (not over) the Forge Core.
  offset?: [number, number, number];
}

const STAGE_GAP = 1.1;
const CONDUIT_RADIUS = 0.04;
const NODE_RADIUS = 0.16;

const STATUS_COLOR: Record<JourneyStageStatus, THREE.Color> = {
  done: new THREE.Color('#ff9a4d'),
  current: new THREE.Color('#4fd4f0'),
  pending: new THREE.Color('#3a414d'),
  failed: new THREE.Color('#f43f5e'),
  skipped: new THREE.Color('#6b5a3e'),
  blocked: new THREE.Color('#7a6a44'),
};

const STATUS_EMISSIVE_INTENSITY: Record<JourneyStageStatus, number> = {
  done: 1.6,
  current: 2.2,
  pending: 0.15,
  failed: 1.8,
  skipped: 0.4,
  blocked: 0.5,
};

export function JourneyPipeline({
  journey,
  particles = 120,
  offset = [0, -2.2, 0],
}: Props) {
  const groupRef = useRef<THREE.Group>(null);

  // --- node geometry / materials -----------------------------------------
  // One shared icosahedron geometry, but a material per node so each can
  // animate independently.
  const sharedGeometry = useMemo(() => new THREE.IcosahedronGeometry(NODE_RADIUS, 0), []);

  const nodeMaterials = useMemo(
    () =>
      journey.stages.map(
        () =>
          new THREE.MeshStandardMaterial({
            color: new THREE.Color('#0d0f15'),
            emissive: new THREE.Color('#ff9a4d'),
            emissiveIntensity: 1.0,
            metalness: 0.4,
            roughness: 0.4,
          }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [journey.stages.length],
  );

  useEffect(() => {
    return () => {
      sharedGeometry.dispose();
      for (const m of nodeMaterials) m.dispose();
    };
  }, [sharedGeometry, nodeMaterials]);

  // --- conduit (a thin tube linking the nodes) ---------------------------
  const conduit = useMemo(() => {
    const totalLength = (journey.stages.length - 1) * STAGE_GAP;
    const geo = new THREE.CylinderGeometry(
      CONDUIT_RADIUS,
      CONDUIT_RADIUS,
      totalLength,
      12,
      1,
      true,
    );
    // CylinderGeometry is along Y by default — rotate to lie along X.
    geo.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#1a1f2b'),
      emissive: new THREE.Color('#ff9a4d'),
      emissiveIntensity: 0.25,
      metalness: 0.5,
      roughness: 0.6,
      transparent: true,
      opacity: 0.85,
    });
    return { geo, mat, totalLength };
  }, [journey.stages.length]);

  useEffect(() => () => {
    conduit.geo.dispose();
    conduit.mat.dispose();
  }, [conduit]);

  // --- flow particles ----------------------------------------------------
  const flow = useMemo(() => {
    const count = Math.max(0, Math.min(particles, 400));
    const positions = new Float32Array(count * 3);
    const offsets = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      offsets[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color('#ffb578'),
      size: 0.045,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geo, mat, count, positions, offsets };
  }, [particles]);

  useEffect(() => () => {
    flow.geo.dispose();
    flow.mat.dispose();
  }, [flow]);

  // Per-frame: update node materials from journey status, animate flow
  // particles along the conduit toward the cursor node.
  const pulseRef = useRef(0);
  const cursorIndex = Math.max(
    0,
    journey.stages.findIndex((s) => s.id === journey.cursor.id),
  );

  useFrame((state, delta) => {
    pulseRef.current += delta;
    const t = state.clock.getElapsedTime();
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);

    if (groupRef.current) {
      // Subtle parallax sway tied to mouse position.
      groupRef.current.rotation.y = state.pointer.x * 0.08;
      groupRef.current.rotation.x = state.pointer.y * 0.04;
    }

    // Drive each node's emissive from its status.
    for (let i = 0; i < journey.stages.length; i++) {
      const stage = journey.stages[i]!;
      const mat = nodeMaterials[i];
      if (!mat) continue;
      mat.emissive.copy(STATUS_COLOR[stage.status]);
      const base = STATUS_EMISSIVE_INTENSITY[stage.status];
      const intensity =
        stage.status === 'current'
          ? base * (0.75 + pulse * 0.6)
          : stage.status === 'failed'
            ? base * (0.85 + pulse * 0.4)
            : base;
      mat.emissiveIntensity = intensity;
    }

    // Particles: animate along the conduit from index 0 toward the cursor.
    // Particles past the cursor are clamped to it (so the flow visually
    // "stops" at the active stage).
    const totalLength = conduit.totalLength;
    if (totalLength > 0) {
      const cursorLength = cursorIndex * STAGE_GAP;
      for (let i = 0; i < flow.count; i++) {
        const u = (flow.offsets[i]! + t * 0.18) % 1; // 0..1 cycle
        const xRaw = u * totalLength;
        // Clamp at the cursor to convey "energy stops here".
        const x = Math.min(xRaw, cursorLength + 0.05);
        // Centre the conduit on the group origin (was 0..totalLength).
        flow.positions[i * 3 + 0] = x - totalLength / 2;
        flow.positions[i * 3 + 1] = Math.sin(t * 2 + i) * 0.02;
        flow.positions[i * 3 + 2] = Math.cos(t * 2 + i) * 0.02;
      }
      const attr = flow.geo.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
    }
  });

  // --- layout ------------------------------------------------------------
  const halfLength = ((journey.stages.length - 1) * STAGE_GAP) / 2;

  return (
    <group ref={groupRef} position={offset}>
      {/* conduit */}
      <mesh geometry={conduit.geo} material={conduit.mat} />

      {/* nodes */}
      {journey.stages.map((stage, i) => (
        <mesh
          key={stage.id}
          geometry={sharedGeometry}
          material={nodeMaterials[i]}
          position={[i * STAGE_GAP - halfLength, 0, 0]}
        />
      ))}

      {/* flow */}
      <points geometry={flow.geo} material={flow.mat} />
    </group>
  );
}
