'use client';

// The labelled strip that always renders above (or beneath) the 3D
// pipeline so users can read stage names regardless of WebGL mode. When
// WebGL is off, this strip IS the pipeline (the canvas overlay is gone).

import { useForgeStore } from '@/lib/store';
import { JourneyStepper } from './JourneyStepper';
import type { Journey } from '@/lib/journey';

interface Props {
  journey: Journey;
}

export function JourneyOverlay({ journey }: Props) {
  const webglReady = useForgeStore((s) => s.webglReady);

  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-3 backdrop-blur-md">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
          journey · stage {String(journey.cursor.index).padStart(2, '0')} ·{' '}
          {journey.cursor.label}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {webglReady ? '3d conduit live' : '2d stepper · webgl off'}
        </p>
      </div>
      <JourneyStepper journey={journey} layout="horizontal" />
    </div>
  );
}
