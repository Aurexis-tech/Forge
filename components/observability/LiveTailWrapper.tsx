'use client';

// LIVE-TAIL WRAPPER — the only client-side piece of the timeline UI.
//
// Tracks whether the parent <details> is expanded. When BOTH:
//   - expanded === true, AND
//   - buildStatus is one of the in-progress statuses (IN_PROGRESS_BUILD_STATUSES),
// it triggers router.refresh() every 5 seconds, which re-runs the
// server component above + re-fetches the timeline. When collapsed
// (the default), polling NEVER fires — no idle work for the user
// who isn't looking.
//
// The decision is encapsulated in `shouldPoll` in
// timeline-display.ts so tests can exercise the logic without a
// real DOM.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { shouldPoll } from './timeline-display';

const POLL_INTERVAL_MS = 5000;

export interface LiveTailWrapperProps {
  buildStatus: string | null;
  children: ReactNode;
}

export function LiveTailWrapper({ buildStatus, children }: LiveTailWrapperProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync expanded state with the underlying <details> element so
  // server-rendered markup stays the source of truth. The ref
  // points at the wrapping div whose first <details> child is the
  // panel disclosure.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const details = root.querySelector('details');
    if (!details) return;
    const onToggle = () => setExpanded(details.open);
    // Sync initial state too (server may have rendered open=false).
    setExpanded(details.open);
    details.addEventListener('toggle', onToggle);
    return () => {
      details.removeEventListener('toggle', onToggle);
    };
  }, []);

  // Polling effect — runs whenever the gate-conditions change.
  useEffect(() => {
    const wantPolling = shouldPoll({ expanded, buildStatus });
    if (wantPolling) {
      timerRef.current = setInterval(() => {
        router.refresh();
      }, POLL_INTERVAL_MS);
    }
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [expanded, buildStatus, router]);

  return <div ref={rootRef}>{children}</div>;
}
