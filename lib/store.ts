// Global UI state shared between the 3D world and the DOM overlay layer.
// Kept intentionally small — the Forge Core reads `coreState` to drive its
// animation, and DOM components call `setCoreState()` on interaction.

import { create } from 'zustand';

export type CoreState =
  | 'idle'
  | 'active'
  | 'thinking'
  | 'working'
  | 'error'
  // The Forge is paused by a global kill switch. Core dims to deep red as
  // a permanent signal until the switch is cleared.
  | 'killed';

// Lightweight projection of the current page's Journey for the 3D world.
// Storing a flat snapshot rather than the rich `Journey` type avoids a
// cyclical import (the journey module pulls in DB types).
export type SnapshotStageStatus =
  | 'done'
  | 'current'
  | 'pending'
  | 'failed'
  | 'skipped'
  | 'blocked';

export interface ActiveJourneySnapshot {
  stages: Array<{
    id: string;
    index: number;
    label: string;
    detail: string;
    status: SnapshotStageStatus;
  }>;
  cursorId: string;
  cursorIndex: number;
  isLive: boolean;
}

interface ForgeStore {
  coreState: CoreState;
  setCoreState: (state: CoreState) => void;

  // True only after we've confirmed WebGL works AND the user hasn't asked
  // to reduce motion. Drives whether <ForgeScene> mounts the canvas or the
  // 2D fallback shell.
  webglReady: boolean;
  setWebglReady: (ready: boolean) => void;

  // The currently-rendered journey, if any. Null on routes that don't have
  // one (intake, sign-in, governance).
  activeJourney: ActiveJourneySnapshot | null;
  setActiveJourney: (j: ActiveJourneySnapshot | null) => void;
}

export const useForgeStore = create<ForgeStore>((set) => ({
  coreState: 'idle',
  setCoreState: (coreState) => set({ coreState }),
  webglReady: false,
  setWebglReady: (webglReady) => set({ webglReady }),
  activeJourney: null,
  setActiveJourney: (activeJourney) => set({ activeJourney }),
}));

// Tiny non-hook accessor for setting state from non-component code
// (e.g. fetch handlers).
export const setCoreState = (state: CoreState) =>
  useForgeStore.getState().setCoreState(state);
