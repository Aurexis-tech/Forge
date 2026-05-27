// Read-only render of a Phase 3 (Software) sandbox run. Surfaces:
//   - iteration-aware phase trail (install → build → isolation,
//     possibly repeated once for self-heal)
//   - a PROMINENT isolation panel — per-entity "A wrote N · B saw 0 ✓"
//     on pass, or a loud "B saw A's rows ✗ — isolation FAILED" on
//     leak, since runtime RLS isolation is the software non-negotiable
//   - any self-heal attempts the runner recorded
//   - the raw sandbox logs

import { GlassPanel } from '@/components/GlassPanel';
import type { SandboxLogLine } from '@/lib/types';

export interface SoftwarePhaseSummaryLite {
  phase: 'install' | 'build' | 'smoke' | 'isolation';
  status: 'ok' | 'failed' | 'skipped';
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  iteration: number;
}

export interface SoftwareSelfHealAttemptLite {
  file_path: string;
  slot_regen_ok: boolean;
  build_ok_after_retry: boolean;
  isolation_ok_after_retry: boolean;
}

export interface SoftwareIsolationLite {
  outcome: 'passed' | 'failed' | 'errored';
  perEntity: Record<string, { aWrote: number; bSawA: number }>;
  leakTable: string | null;
  leakCount: number;
  errorMessage: string | null;
  vacuous: boolean;
}

interface Props {
  passed: boolean;
  buildOk: boolean | null;
  isolationOk: boolean | null;
  isolation: SoftwareIsolationLite | null;
  durationMs: number | null;
  provider: string;
  iterations: number;
  phases: SoftwarePhaseSummaryLite[];
  lines: SandboxLogLine[];
  selfHealAttempts: SoftwareSelfHealAttemptLite[];
  error: string | null;
}

const PHASE_TONE: Record<SoftwarePhaseSummaryLite['status'], string> = {
  ok: 'border-emerald-400/40 text-emerald-300',
  failed: 'border-rose-400/40 text-rose-300',
  skipped: 'border-white/15 text-forge-dim',
};

export function SoftwareTestView({
  passed,
  buildOk,
  isolationOk,
  isolation,
  durationMs,
  provider,
  iterations,
  phases,
  lines,
  selfHealAttempts,
  error,
}: Props) {
  return (
    <GlassPanel className={passed ? 'border-emerald-400/30' : 'border-rose-400/30'}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={
                'inline-block h-2 w-2 rounded-full shadow ' +
                (passed
                  ? 'bg-emerald-300 shadow-emerald-300/40'
                  : 'bg-rose-300 shadow-rose-300/40')
              }
            />
            <h2 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-text/90">
              software sandbox · {passed ? 'passed' : 'failed'}
            </h2>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            provider · {provider} ·{' '}
            {typeof durationMs === 'number'
              ? (durationMs / 1000).toFixed(1) + 's'
              : '—'}
            {iterations > 0 ? ' · ' + iterations + ' self-heal' : ''}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-forge-text/90 sm:grid-cols-4">
          <Stat label="build" value={renderTri(buildOk)} />
          <Stat label="isolation" value={renderTri(isolationOk)} />
          <Stat label="iterations" value={iterations} />
          <Stat label="phases" value={phases.length} />
        </div>

        {/* PROMINENT isolation panel — the software non-negotiable. */}
        <IsolationPanel isolation={isolation} isolationOk={isolationOk} />

        <section>
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
            phase trail
          </h3>
          <ol className="mt-2 flex flex-col gap-1.5">
            {phases.map((p, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2"
              >
                <span
                  className={
                    'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.3em] ' +
                    PHASE_TONE[p.status]
                  }
                >
                  {p.phase} @ {p.iteration} · {p.status}
                </span>
                {p.timed_out ? (
                  <span className="font-mono text-[10px] text-rose-300">
                    timed-out
                  </span>
                ) : null}
                {p.exit_code !== null ? (
                  <span className="font-mono text-[10px] text-forge-dim">
                    exit {p.exit_code}
                  </span>
                ) : null}
                <span className="font-mono text-[10px] text-forge-dim">
                  {(p.duration_ms / 1000).toFixed(1)}s
                </span>
              </li>
            ))}
          </ol>
        </section>

        {selfHealAttempts.length > 0 ? (
          <section>
            <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
              self-heal attempts ({selfHealAttempts.length})
            </h3>
            <ul className="mt-2 flex flex-col gap-2">
              {selfHealAttempts.map((a, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2 font-mono text-[11px] text-amber-100"
                >
                  <p>
                    <span className="text-forge-dim">file: </span>
                    {a.file_path}
                  </p>
                  <p className="mt-1 text-[10px]">
                    <span className="text-forge-dim">regen: </span>
                    {a.slot_regen_ok ? 'ok' : 'failed'}
                    <span className="mx-2 text-forge-dim">·</span>
                    <span className="text-forge-dim">build after retry: </span>
                    {a.build_ok_after_retry ? 'passed' : 'failed'}
                    <span className="mx-2 text-forge-dim">·</span>
                    <span className="text-forge-dim">
                      isolation after retry:{' '}
                    </span>
                    {a.isolation_ok_after_retry ? 'passed' : 'failed'}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 font-mono text-[11px] text-rose-200"
          >
            {error}
          </p>
        ) : null}

        <section>
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
            sandbox logs (last lines)
          </h3>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[10px] leading-5 text-forge-text/85">
            {lines.length === 0
              ? '(no logs captured)'
              : lines
                  .map(
                    (ln) =>
                      '[' +
                      String(ln.phase) +
                      '/' +
                      ln.stream +
                      '] ' +
                      ln.message,
                  )
                  .join('\n')}
          </pre>
        </section>

        <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {passed
            ? 'locked · database provisioning + deploy lands next · sandbox always destroyed'
            : 'software sandbox failed · review the isolation panel above + the logs · isolation leaks are a hard stop and do not self-heal'}
        </p>
      </div>
    </GlassPanel>
  );
}

function IsolationPanel({
  isolation,
  isolationOk,
}: {
  isolation: SoftwareIsolationLite | null;
  isolationOk: boolean | null;
}) {
  // No isolation result yet — the build either hasn't reached
  // isolation or the run crashed before producing one.
  if (!isolation) {
    return (
      <section
        aria-label="cross-user isolation test"
        className="rounded-xl border border-white/10 bg-black/30 p-4"
      >
        <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
          cross-user isolation
        </h3>
        <p className="mt-2 text-sm text-forge-dim">
          The isolation phase did not produce a structured result. Likely
          the build failed before pglite + the migration could apply.
        </p>
      </section>
    );
  }

  // Vacuous pass — auth off, no owner-scoped rows to leak.
  if (isolation.vacuous) {
    return (
      <section
        aria-label="cross-user isolation test"
        className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.05] p-4"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-emerald-300 shadow-emerald-300/40"
          />
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-emerald-300">
            cross-user isolation · vacuously passed
          </h3>
        </div>
        <p className="mt-2 text-sm text-forge-text/85">
          Spec auth is off → no owner-scoped rows → no cross-user RLS to
          test. The migration still ran and any public-read policies were
          applied.
        </p>
      </section>
    );
  }

  // Genuine leak — loud, distinct from a generic build failure.
  if (isolationOk === false || isolation.outcome === 'failed') {
    return (
      <section
        aria-label="cross-user isolation test"
        className="rounded-xl border-2 border-rose-400/60 bg-rose-500/[0.08] p-4 shadow-[0_0_16px_rgba(244,63,94,0.18)]"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full bg-rose-400 shadow-rose-400/60"
          />
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-rose-300">
            cross-user isolation · FAILED — RLS leak
          </h3>
        </div>
        <p className="mt-2 text-sm text-rose-100">
          {isolation.errorMessage ??
            "B read at least one of A's owner-scoped rows. This is a RUNTIME RLS leak — the structural check at codegen passed but the database does not actually isolate."}
        </p>
        {isolation.leakTable ? (
          <p className="mt-1 font-mono text-[10px] text-rose-200">
            first leaking table:{' '}
            <span className="text-rose-100">{isolation.leakTable}</span>
            <span className="mx-2 text-rose-300">·</span>
            total rows B saw of A:{' '}
            <span className="text-rose-100">{isolation.leakCount}</span>
          </p>
        ) : null}
        <PerEntityTable perEntity={isolation.perEntity} leaked />
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.3em] text-rose-200">
          this is a hard stop · no self-heal · regenerate the migration
          or refine the spec
        </p>
      </section>
    );
  }

  // Errored — the driver didn't produce a clean verdict (migration
  // load/apply failed, pglite install failed, driver crashed).
  if (isolation.outcome === 'errored') {
    return (
      <section
        aria-label="cross-user isolation test"
        className="rounded-xl border border-amber-400/40 bg-amber-500/[0.06] p-4"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-amber-300 shadow-amber-300/40"
          />
          <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-amber-300">
            cross-user isolation · errored
          </h3>
        </div>
        <p className="mt-2 text-sm text-amber-100">
          {isolation.errorMessage ??
            'The isolation driver could not produce a verdict. Review the logs.'}
        </p>
      </section>
    );
  }

  // Passed — A wrote N, B saw 0 for every entity.
  return (
    <section
      aria-label="cross-user isolation test"
      className="rounded-xl border border-emerald-400/40 bg-emerald-500/[0.05] p-4"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full bg-emerald-300 shadow-emerald-300/40"
        />
        <h3 className="font-mono text-[10px] uppercase tracking-[0.4em] text-emerald-300">
          cross-user isolation · passed
        </h3>
      </div>
      <p className="mt-2 text-sm text-forge-text/85">
        Two synthetic users A and B ran against an ephemeral Postgres with
        the generated RLS migration applied. A inserted rows; B saw{' '}
        <span className="text-emerald-200">zero</span> of them.
      </p>
      <PerEntityTable perEntity={isolation.perEntity} leaked={false} />
    </section>
  );
}

function PerEntityTable({
  perEntity,
  leaked,
}: {
  perEntity: Record<string, { aWrote: number; bSawA: number }>;
  leaked: boolean;
}) {
  const entries = Object.entries(perEntity);
  if (entries.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1">
      {entries.map(([table, counts]) => {
        const tableLeaked = counts.bSawA > 0;
        const tone =
          tableLeaked && leaked
            ? 'text-rose-100 border-rose-400/50 bg-rose-500/[0.08]'
            : tableLeaked
              ? 'text-rose-100 border-rose-400/30'
              : 'text-emerald-100 border-emerald-400/30 bg-emerald-500/[0.04]';
        const icon = tableLeaked ? '✗' : '✓';
        return (
          <li
            key={table}
            className={
              'flex items-center justify-between rounded-md border px-3 py-1.5 font-mono text-[11px] ' +
              tone
            }
          >
            <span>{table}</span>
            <span>
              A wrote {counts.aWrote} · B saw {counts.bSawA} {icon}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
      <p className="text-forge-dim">{label}</p>
      <p className="mt-1 text-base text-forge-amber">{value}</p>
    </div>
  );
}

function renderTri(v: boolean | null): string {
  if (v === true) return 'ok';
  if (v === false) return 'failed';
  return '—';
}
