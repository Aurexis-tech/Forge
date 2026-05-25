// The polished "your agent is shipped" view. Shown when the journey is
// either deployed (on_demand) or has an active/paused runtime
// (always_on / scheduled). One panel that answers: what does it do, where
// does it live, what has it cost, and how do I poke it?

import Link from 'next/link';
import { GlassPanel } from '@/components/GlassPanel';
import { RunsList } from '@/components/runtime/RunsList';
import { RuntimeControls } from '@/components/runtime/RuntimeControls';
import { describeCron } from '@/lib/engine/runtime/cron';
import type { AgentSpec } from '@/lib/engine/spec/schema';
import type {
  AgentRun,
  AgentRuntime,
  Build,
  Project,
} from '@/lib/types';

interface Props {
  project: Project;
  spec: AgentSpec;
  build: Build;
  runtime: AgentRuntime | null;
  runs: AgentRun[];
  costToDateUsd: number;
  isRuntimeMode: boolean;
}

export function AgentDashboard({
  project,
  spec,
  build,
  runtime,
  runs,
  costToDateUsd,
  isRuntimeMode,
}: Props) {
  return (
    <GlassPanel className="border-forge-amber/50 shadow-amber">
      <div className="flex flex-col gap-6">
        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-forge-amber shadow-amber"
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              agent · shipped
            </h2>
          </div>
          <span className="rounded-full border border-forge-amber/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
            ${costToDateUsd.toFixed(4)} to date
          </span>
        </header>

        {/* What it does */}
        <section>
          <h3 className="text-2xl font-medium text-forge-text">{spec.name}</h3>
          <p className="mt-2 text-sm text-forge-dim">{spec.goal}</p>
          <p className="mt-3 text-sm leading-relaxed text-forge-text/90">
            {spec.description}
          </p>
        </section>

        {/* Where it lives */}
        {isRuntimeMode ? (
          <RuntimeSection runtime={runtime} runs={runs} projectId={project.id} />
        ) : (
          <LiveUrlSection build={build} />
        )}

        {/* Source */}
        {build.repo_url ? (
          <section className="rounded-lg border border-white/10 bg-black/30 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
              source
            </p>
            <a
              href={build.repo_url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 block break-all font-mono text-sm text-forge-cyan hover:underline"
            >
              {build.repo_url}
            </a>
          </section>
        ) : null}

        {/* Quick controls */}
        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-white/5 pt-4">
          <Link
            href="/governance"
            className="rounded-xl border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-white/30 hover:text-forge-text"
          >
            governance
          </Link>
          {!isRuntimeMode && build.deploy_url ? (
            <a
              href={build.deploy_url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.3em] text-forge-amber transition hover:bg-forge-amber/25"
            >
              Open agent
              <span aria-hidden>↗</span>
            </a>
          ) : null}
        </footer>
      </div>
    </GlassPanel>
  );
}

function LiveUrlSection({ build }: { build: Build }) {
  if (!build.deploy_url) {
    return (
      <section className="rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-forge-dim">
        Deploy didn&apos;t populate a URL.
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-forge-amber/30 bg-forge-amber/[0.05] p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
        live url · public
      </p>
      <a
        href={build.deploy_url}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-1 block break-all font-mono text-base text-forge-amber hover:underline"
      >
        {build.deploy_url}
      </a>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        anyone with this url can call the agent. add access control in the
        agent handler if needed.
      </p>
    </section>
  );
}

function RuntimeSection({
  runtime,
  runs,
  projectId,
}: {
  runtime: AgentRuntime | null;
  runs: AgentRun[];
  projectId: string;
}) {
  if (!runtime) {
    return (
      <section className="rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-forge-dim">
        Runtime is not configured yet.
      </section>
    );
  }
  const cadence = describeCron(runtime.schedule_cron);
  return (
    <section className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="cadence" value={cadence} />
        <Stat
          label="last run"
          value={runtime.last_run_at ? formatTime(runtime.last_run_at) : '—'}
        />
        <Stat
          label="next run"
          value={
            runtime.status === 'active' && runtime.next_run_at
              ? formatTime(runtime.next_run_at)
              : '—'
          }
        />
        <Stat
          label="runs"
          value={
            runtime.run_count +
            ' · ' +
            runtime.fail_count +
            ' fail'
          }
        />
      </div>
      <RuntimeControls projectId={projectId} status={runtime.status} />
      <div>
        <h4 className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          recent runs
        </h4>
        <div className="mt-2">
          <RunsList runs={runs} />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
        {label}
      </p>
      <p className="mt-1 font-mono text-xs text-forge-text">{value}</p>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
