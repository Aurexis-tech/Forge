'use client';

// Pushes the current page's Journey into the Forge store so the persistent
// 3D world can render its pipeline. Mounted on routes that have a Journey
// (project detail); unmounting clears the snapshot so other routes don't
// carry stale state.
//
// Also triggers a brief "working" Core eruption the first time the
// journey reports isLive — the celebratory moment.

import { useEffect, useRef } from 'react';
import { useForgeStore, type ActiveJourneySnapshot } from '@/lib/store';
import type { Journey } from '@/lib/journey';

function toSnapshot(journey: Journey): ActiveJourneySnapshot {
  return {
    stages: journey.stages.map((s) => ({
      id: s.id,
      index: s.index,
      label: s.label,
      detail: s.detail,
      status: s.status,
    })),
    cursorId: journey.cursor.id,
    cursorIndex: journey.cursor.index,
    isLive: journey.isLive,
  };
}

export function JourneyBridge({ journey }: { journey: Journey }) {
  const setActiveJourney = useForgeStore((s) => s.setActiveJourney);
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const prevLiveRef = useRef<boolean | null>(null);

  useEffect(() => {
    setActiveJourney(toSnapshot(journey));
    // Celebrate the transition into live exactly once per mount.
    if (prevLiveRef.current === false && journey.isLive) {
      setCoreState('working');
      const t = setTimeout(() => setCoreState('active'), 1400);
      prevLiveRef.current = journey.isLive;
      return () => {
        clearTimeout(t);
        setActiveJourney(null);
      };
    }
    prevLiveRef.current = journey.isLive;
    return () => setActiveJourney(null);
  }, [journey, setActiveJourney, setCoreState]);

  return null;
}
