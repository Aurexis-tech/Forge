'use client';

// Phase 3-6 (Software) go-live flow. The lightest of the three runtime
// activation flows — there's no schedule, no env, no cron. Just an
// authorisation gate that records the user explicitly marked the app
// live.
//
// REUSES AuthorizationGate. POSTs to /software/runtime/activate with
// { authorized: true }. The route re-checks every guard server-side
// (kind, build status, kill switch via projectRouteGuard).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  projectName: string;
  deployUrl: string;
  // For the gate's summary. Pulled from the SoftwareSpec.
  entityCount: number;
}

export function SoftwareActivateRuntimeFlow({
  projectId,
  projectName,
  deployUrl,
  entityCount,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [error, setError] = useState<string | null>(null);

  async function onApprove() {
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/software/runtime/activate',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ authorized: true }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Go-live failed.');
    }
  }

  return (
    <AuthorizationGate
      title={'Mark this app live?'}
      summary={[
        { label: 'project', value: projectName },
        { label: 'app url', value: deployUrl },
        {
          label: 'database',
          value:
            entityCount +
            ' entity table' +
            (entityCount === 1 ? '' : 's') +
            ' · RLS migration applied',
        },
        {
          label: 'kill switch',
          value: 'project-scope · trips this app offline at any time',
        },
      ]}
      helper={
        'The deployed app is already serving at its Vercel URL. Marking it ' +
        'live records the user-authorised "this is the production app" beat ' +
        'and wires the kill switch to take it offline at any time. Cost ' +
        'dimensions for software are infra (Vercel hosting + Supabase) — ' +
        'the governance budget + kill switch still own the hard stop.'
      }
      confirmLabel="Mark app live"
      cancelLabel="Not yet"
      onApprove={onApprove}
      onCancel={() => {
        /* no-op — the gate stays mounted until status changes */
      }}
      error={error}
    />
  );
}
