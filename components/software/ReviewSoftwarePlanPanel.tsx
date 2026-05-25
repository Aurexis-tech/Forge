'use client';

// Approve-gate panel for the Phase 3 software build plan. Mirrors
// ReviewOrchestrationPanel.tsx — same confirm + refine semantics,
// same state transitions; renders the SoftwareBuildPlanView.

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { GlassPanel } from '@/components/GlassPanel';
import { useForgeStore } from '@/lib/store';
import { SoftwareBuildPlanView } from './SoftwareBuildPlanView';
import type { SoftwareBuildPlan } from '@/lib/engine/software/planner/schema';

interface Props {
  projectId: string;
  plan: SoftwareBuildPlan;
}

export function ReviewSoftwarePlanPanel({ projectId, plan }: Props) {
  const router = useRouter();
  const setCoreState = useForgeStore((s) => s.setCoreState);
  const [approving, setApproving] = useState(false);
  const [refining, setRefining] = useState(false);
  const [showRefine, setShowRefine] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onApprove() {
    setError(null);
    setApproving(true);
    setCoreState('working');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/software/plan/approve',
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Approve failed.');
      setApproving(false);
    }
  }

  async function onRefine(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = note.trim();
    if (!trimmed) {
      setError('Describe the change you want.');
      return;
    }
    setRefining(true);
    setCoreState('thinking');
    try {
      const res = await fetch(
        '/api/projects/' + projectId + '/software/plan/refine',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: trimmed }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setCoreState('idle');
      setShowRefine(false);
      setNote('');
      router.refresh();
    } catch (err) {
      setCoreState('error');
      setError(err instanceof Error ? err.message : 'Refine failed.');
      setRefining(false);
    }
  }

  const busy = approving || refining;

  return (
    <GlassPanel>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            build plan · awaiting approval
          </h2>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            phase 3 · review-only · code generation lands later
          </p>
        </div>

        <SoftwareBuildPlanView plan={plan} />

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/5 pt-5">
          <button
            type="button"
            onClick={() => setShowRefine((v) => !v)}
            disabled={busy}
            className="rounded-xl border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-forge-cyan/50 hover:text-forge-cyan disabled:cursor-not-allowed disabled:opacity-60"
          >
            {showRefine ? 'cancel refine' : 'refine'}
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {approving ? 'Locking…' : 'Approve build plan'}
          </button>
        </div>

        {showRefine ? (
          <form
            onSubmit={onRefine}
            className="flex flex-col gap-3 rounded-xl border border-forge-cyan/30 bg-forge-cyan/[0.04] p-4"
          >
            <label className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-cyan">
              describe the change
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              disabled={refining}
              placeholder="e.g. 'the User entity should include an email_verified boolean' or 'tighten the approvals task description'"
              className="w-full resize-y rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text placeholder:text-forge-dim/70 focus:border-forge-cyan/60 focus:outline-none focus:ring-2 focus:ring-forge-cyan/30"
            />
            <div className="flex items-center justify-end">
              <button
                type="submit"
                disabled={refining}
                className="inline-flex items-center gap-2 rounded-xl border border-forge-cyan/60 bg-forge-cyan/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-cyan shadow-cyan transition hover:bg-forge-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {refining ? 'Re-planning…' : 'Apply refinement'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </GlassPanel>
  );
}
