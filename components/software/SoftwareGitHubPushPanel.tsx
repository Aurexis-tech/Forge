'use client';

// Phase 3-5b (Software) push gate. Mirrors SystemGitHubPushPanel; the
// only differences are the endpoint, the copy ("full Next.js app"
// vs. "system bundle"), and the included-files framing.
//
// The component knows nothing about how the push actually works —
// it presents the action plainly, gathers explicit consent, and
// POSTs to /software/build/push with { authorized: true }. The
// server re-checks every guard.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthorizationGate } from '@/components/gate/AuthorizationGate';
import { deriveRepoName } from '@/lib/engine/integrations/github-name';
import { useForgeStore } from '@/lib/store';

interface Props {
  projectId: string;
  projectName: string;
  accountLogin: string;
  filesCount: number;
  // For copy: number of entity tables that landed in the RLS migration.
  entityCount: number;
  isRetry?: boolean;
}

export function SoftwareGitHubPushPanel({
  projectId,
  projectName,
  accountLogin,
  filesCount,
  entityCount,
  isRetry,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [error, setError] = useState<string | null>(null);

  const proposedName = deriveRepoName(projectName);

  async function onApprove() {
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/software/build/push',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ authorized: true }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok)
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Push failed.');
    }
  }

  return (
    <AuthorizationGate
      title={'Create a private GitHub repository and push the full app?'}
      summary={[
        { label: 'account', value: '@' + accountLogin },
        { label: 'repo', value: proposedName + ' (private)' },
        {
          label: 'contents',
          value:
            filesCount +
            ' files · Next.js app + Supabase auth + ' +
            entityCount +
            ' entity table' +
            (entityCount === 1 ? '' : 's') +
            ' with RLS',
        },
        { label: 'commit', value: 'initial commit on main' },
      ]}
      helper={
        isRetry
          ? 'Previous push failed. A name collision is resolved by appending a numeric suffix. The Forge only touches this repo.'
          : 'A name collision is resolved by appending a numeric suffix. The Forge will not modify any other repo on your account, and the push uses only the scoped OAuth token you granted at connect time.'
      }
      confirmLabel="Create repo & push app"
      cancelLabel="Not yet"
      onApprove={onApprove}
      onCancel={() => {
        /* no-op — the gate stays mounted until status changes */
      }}
      error={error}
    />
  );
}
