// Mid-apply kill-switch watcher.
//
// `terraform apply` is the only operation in the engine that writes
// to real cloud and spends real money. P4-5b runs it BEHIND:
//
//   1. assertAllowed BEFORE the spawn (kill switch active → apply
//      never starts). That guard is the route's responsibility.
//   2. THIS watcher, polled WHILE the spawn is running. If the
//      kill switch flips mid-apply, the watcher fires
//      AbortController.abort() and the provider's spawned
//      `terraform apply` receives SIGINT. Terraform finishes the
//      in-flight resource cleanly and stops; the partial state is
//      captured by the route afterwards.
//
// This is the same pattern the Phase 2 system runtime executor
// uses for its mid-run watcher (lib/engine/system/runtime/executor.ts).
// Kept tiny + dependency-free so it can be unit-tested independently.

import { activeKillSwitch } from '@/lib/engine/governance/killswitch';
import type { ForgeSupabase } from '@/lib/supabase';

export interface WatcherScope {
  userId: string | null;
  projectId: string | null;
}

export interface KillSwitchWatcher {
  // Stop polling. Always call this in a `finally` after the apply
  // returns — leaving the poll running leaks a setInterval.
  stop(): void;
  // True iff the watcher fired abort(). The route reads this to
  // distinguish a kill-switch interruption from a generic
  // provider-side abort.
  readonly tripped: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

// The env-overridable default. Tests set INFRA_KILL_SWITCH_POLL_MS
// to a small value (e.g. 50 ms) so the mid-apply kill-switch dry-run
// doesn't race against the 2 s production cadence. Production code
// never sets this — the default keeps an apply's poll cheap.
function defaultIntervalMs(): number {
  const raw = process.env.INFRA_KILL_SWITCH_POLL_MS;
  if (!raw) return DEFAULT_POLL_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10 ? n : DEFAULT_POLL_INTERVAL_MS;
}

/**
 * Start a kill-switch watcher. Polls `activeKillSwitch` every
 * `intervalMs` (default 2 s, configurable via env override) and
 * calls `controller.abort()` on the FIRST poll that returns a truthy
 * switch. Idempotent — once tripped, subsequent polls are skipped.
 *
 * Returns a handle the caller MUST `stop()` in a `finally` block.
 */
export function startKillSwitchWatcher(args: {
  controller: AbortController;
  scope: WatcherScope;
  supabase: ForgeSupabase;
  intervalMs?: number;
  // Test-only hook — when set, replaces the live activeKillSwitch
  // call so unit tests don't need to round-trip through the in-memory
  // supabase. Production code path NEVER passes this; the route
  // omits it.
  pollFn?: () => Promise<boolean>;
}): KillSwitchWatcher {
  let tripped = false;
  let stopped = false;
  const interval = args.intervalMs ?? defaultIntervalMs();

  const poll = async () => {
    if (stopped || tripped) return;
    let active = false;
    try {
      if (args.pollFn) {
        active = await args.pollFn();
      } else {
        const ks = await activeKillSwitch(args.scope, args.supabase);
        active = ks != null;
      }
    } catch {
      // Fail-open intentionally — a transient DB blip should NOT
      // interrupt a running apply. The route's pre-apply
      // assertAllowed already failed-closed before the spawn; if
      // governance was healthy at start we tolerate brief outages
      // here.
      active = false;
    }
    if (active && !stopped) {
      tripped = true;
      args.controller.abort();
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, interval);

  // First poll synchronously so a kill switch that was active at
  // start time is honoured immediately (matches the route's
  // assertAllowed but defensive in case the route forgot).
  void poll();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    get tripped() {
      return tripped;
    },
  };
}
