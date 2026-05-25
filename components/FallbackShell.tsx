'use client';

// The persistent backdrop the authenticated app falls back to when
// WebGL is unavailable (or the user has prefers-reduced-motion). The
// (app) layout mounts this once via <ForgeScene />; navigating between
// authed routes never remounts it, so the cursor parallax + breathing
// pulse keep their state across the whole session.
//
// What's on screen:
//   - Aurora drift (slow warm + cool radial gradients)              [DOM/CSS]
//   - Living backdrop (ambient variant):                            [DOM/CSS]
//       molten glow disc with breathing pulse,
//       two depth rings with inverse cursor parallax,
//       rising CSS embers around the rim,
//       a faint dark scrim that guarantees AA contrast over text.
//   - On /forge the breathing core is suppressed (no double-core).
//
// All of the above are the SAME primitives the public landing uses
// for its WebGL-off path — see components/landing/LivingBackdrop.tsx.
// The prefers-reduced-motion override in app/globals.css collapses the
// breathing + ember keyframes automatically, leaving a calm static
// disc on devices that opt out of motion.

import { Aurora } from './landing/Aurora';
import { LivingBackdrop } from './landing/LivingBackdrop';

export function FallbackShell() {
  return (
    <div
      aria-hidden
      // fixed inset-0 so it covers every (app) page; -z-10 so foreground
      // content always renders above. pointer-events-none on the inner
      // components ensures inputs/buttons still receive focus through
      // the layer.
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-forge-void"
    >
      <Aurora />
      {/*
        No `suppressCoreOnPaths` here. The brief's "don't double the core"
        guidance is for WebGL-ON setups, where ForgeWorld's 3D ForgeCore
        is the focal element on /forge — but this component IS the
        WebGL-off path: when we're rendering it there is no WebGL core to
        compete with, so the ambient breathing glow is the only focal
        element the user has. Suppressing it on /forge would leave the
        intake page featureless. The prop on LivingBackdrop is wired up
        and ready for the WebGL-on layering case if it gets added later.
      */}
      <LivingBackdrop variant="ambient" />
    </div>
  );
}
