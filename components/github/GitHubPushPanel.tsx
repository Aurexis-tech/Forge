'use client';

// Drives the authorisation gate for the GitHub push. This component knows
// nothing about how the push actually works — it just presents the action
// plainly, gathers explicit consent, and POSTs to /build/push with
// { authorized: true }. The server re-checks every guard.

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
}

export function GitHubPushPanel({
  projectId,
  projectName,
  accountLogin,
  filesCount,
}: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [error, setError] = useState<string | null>(null);

  const proposedName = deriveRepoName(projectName);

  async function onApprove() {
    setError(null);
    setCoreState('working');
    try {
      const res = await fetch('/api/projects/' + projectId + '/build/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authorized: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Push failed.');
    }
  }

  return (
    <AuthorizationGate
      title={'Create a private GitHub repository and push this build?'}
      summary={[
        { label: 'account', value: '@' + accountLogin },
        { label: 'repo', value: proposedName + ' (private)' },
        { label: 'files', value: filesCount + ' files in a single initial commit' },
        { label: 'branch', value: 'main' },
      ]}
      helper={
        'A name collision is resolved by appending a numeric suffix. ' +
        'The Forge will not modify any other repo on your account, and the ' +
        'push uses only the scoped OAuth token you granted at connect time.'
      }
      confirmLabel="Create repo & push"
      cancelLabel="Not yet"
      onApprove={onApprove}
      onCancel={() => {
        /* no-op — the gate stays mounted until status changes */
      }}
      error={error}
    />
  );
}
