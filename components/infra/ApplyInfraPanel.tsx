'use client';

// Phase 4-5b kick-off panel. Mounts when the build is at
// status='plan_confirmed' — the user has typed-confirmed the plan
// in P4-5a and is one click away from the SINGLE write to real
// cloud in the engine.
//
// The panel reuses the standard AuthorizationGate: `apply` itself is
// gated server-side by:
//   - assertAllowed (kill switch + budget)
//   - status='plan_confirmed' + a typed-phrase-verified plan row
// So the client-side gate doesn't need a typed-confirm input —
// that already happened in P4-5a. This panel just surfaces what's
// about to happen and posts on confirm.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { useForgeStore } from '@/lib/store';
import type { PublicInfraPlan } from '@/lib/engine/infra/cloud/persistence';

interface Props {
  projectId: string;
  plan: PublicInfraPlan;
}

export function ApplyInfraPanel({ projectId, plan }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [error, setError] = useState<string | null>(null);

  async function onApprove() {
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/infra/build/apply',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // 503 = kill switch tripped; 502 = apply failed; either way
      // the server persisted apply_failed and the page reload will
      // render the failed view.
      if (res.status === 503 || res.status === 502) {
        setCoreState('error');
        router.refresh();
        return;
      }
      if (res.status === 412) {
        throw new Error(
          body.error ?? 'connect a cloud provider before applying',
        );
      }
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Apply failed.');
    }
  }

  return (
    <AuthorizationGate
      title="Apply the confirmed plan to real cloud?"
      summary={[
        { label: 'create', value: String(plan.create_count) + ' resources' },
        { label: 'change', value: String(plan.change_count) },
        { label: 'destroy / replace', value: String(plan.destroy_count) },
        plan.destructive
          ? { label: 'destructive', value: 'yes · typed-confirm verified' }
          : { label: 'destructive', value: 'no · pure-create' },
        {
          label: 'ceiling',
          value:
            plan.ceiling_verdict === 'within_budget'
              ? 'within budget · re-checked'
              : 'no hard cap set',
        },
      ]}
      helper={
        'This runs the EXACT plan artifact the destructive-confirm gate verified in P4-5a — no drift. Live cloud resources will be created and your ledger will be billed for the actual monthly cost. The kill switch can refuse this call (pre-apply) AND interrupt it mid-flight (the spawned terraform will SIGINT cleanly).'
      }
      confirmLabel="Apply now"
      cancelLabel="Not yet"
      onApprove={onApprove}
      onCancel={() => {
        /* no-op — gate stays mounted until status changes */
      }}
      error={error}
    />
  );
}
