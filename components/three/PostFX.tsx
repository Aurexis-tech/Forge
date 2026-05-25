'use client';

import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';

interface PostFXProps {
  // Disable the heavier effects on small / low-power devices.
  enableBloom?: boolean;
}

export function PostFX({ enableBloom = true }: PostFXProps) {
  if (!enableBloom) return null;
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <Bloom
        intensity={0.85}
        luminanceThreshold={0.18}
        luminanceSmoothing={0.2}
        mipmapBlur
      />
      <Vignette
        offset={0.35}
        darkness={0.85}
        blendFunction={BlendFunction.NORMAL}
      />
    </EffectComposer>
  );
}
