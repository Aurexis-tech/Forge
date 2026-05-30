// WorkshopShell — the AI-futuristic chrome for /projects/[id]. The page
// loads ALL the real data (project, spec, plan, build, journey, runtime,
// per-project spend) and passes it in here; the shell renders the AI
// header + journey pipeline + phase indicator + raw-intent card and then
// slots the existing domain panels via `children`. The domain panels stay
// functionally untouched (gates inside them stay live) — only the outer
// chrome changes.
//
// Honesty rules:
//   - Header status pill comes from `headerStatusVm(journey, project.status)`
//     — never invents a state.
//   - Header meta shows real cost-to-date only (no tokens / cache / latency
//     because no per-project rollup exists for those).
//   - Mold badge resolves through the real `resolveProjectMold(project, spec)`
//     — shows "Detecting…" until the classifier has run.
//   - Journey pipeline is driven by the real `deriveJourney` output.
//   - Phase indicator is purely informational; the cursor's real stage
//     decides which of the four phases is highlighted.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { MOLD_META, resolveProjectMold } from '@/lib/molds';
import {
  headerMetaVm,
  headerStatusVm,
  phasesVm,
  type WorkshopColor,
} from '@/lib/workshop-vm';
import type { Journey } from '@/lib/journey';
import type { Project, Spec } from '@/lib/types';
import { JourneyPipelineAi } from './JourneyPipelineAi';
import styles from './workshop.module.css';

const STATUS_TEXT: Readonly<Record<WorkshopColor, string>> = {
  mint: 'text-lq-mint',
  aurora: 'text-lq-aurora',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
  'ink-dim': 'text-lq-ink-dim',
};

const STATUS_BORDER: Readonly<Record<WorkshopColor, string>> = {
  mint: 'border-lq-mint/50 bg-lq-mint/[0.06]',
  aurora: 'border-lq-aurora/50 bg-lq-aurora/[0.06]',
  amber: 'border-lq-amber/50 bg-lq-amber/[0.07]',
  rose: 'border-lq-rose/50 bg-lq-rose/[0.07]',
  'ink-dim': 'border-lq-line bg-lq-elev-1',
};

const STATUS_DOT: Readonly<Record<WorkshopColor, string>> = {
  mint: 'bg-lq-mint',
  aurora: 'bg-lq-aurora',
  amber: 'bg-lq-amber',
  rose: 'bg-lq-rose',
  'ink-dim': 'bg-lq-ink-faint',
};

interface Props {
  project: Project;
  spec: Spec | null;
  journey: Journey;
  costToDateUsd: number;
  /** The full slot of existing domain panels, rendered after the shell. */
  children: ReactNode;
}

export function WorkshopShell({
  project,
  spec,
  journey,
  costToDateUsd,
  children,
}: Props) {
  const mold = resolveProjectMold(project, spec);
  const moldMeta = MOLD_META[mold];
  const status = headerStatusVm({
    journey,
    projectStatus: project.status,
  });
  const meta = headerMetaVm({
    projectId: project.id,
    createdAtIso: project.created_at,
    costToDateUsd,
  });
  const phases = phasesVm(journey);

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-2 py-12 font-ui text-lq-ink">
      {/* Back to /projects — the only real header action that exists. */}
      <Link
        href="/projects"
        className="self-start font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint transition hover:text-lq-aurora"
      >
        ← projects
      </Link>

      {/* Header — name + mold + status pill + real meta. */}
      <LiquidGlass as="div" className="flex flex-col gap-4 p-6 font-ui">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-code text-[10px] uppercase tracking-[0.35em] text-lq-aurora">
            project · {meta.idShort}
          </span>
          <span
            className={
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] ' +
              (mold === 'unclassified'
                ? 'border-lq-line text-lq-ink-faint'
                : moldStyleFor(mold))
            }
            title={moldMeta.description}
          >
            {moldMeta.badgeLabel}
          </span>
          <span
            aria-hidden
            className="h-px flex-1 bg-gradient-to-r from-lq-aurora/40 to-transparent"
          />
          <span
            className={
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] ' +
              STATUS_BORDER[status.color] +
              ' ' +
              STATUS_TEXT[status.color] +
              ' ' +
              (status.pulse ? styles.activeRim : '')
            }
          >
            <span
              aria-hidden
              className={
                'inline-block h-1.5 w-1.5 rounded-full ' +
                STATUS_DOT[status.color]
              }
            />
            {status.label}
          </span>
        </div>

        <h1 className="font-ui text-3xl font-extrabold tracking-[-0.02em] text-lq-ink sm:text-4xl">
          {project.name}
        </h1>

        <p className="font-code text-[11px] text-lq-ink-faint">
          forged {meta.createdLabel}
          {meta.spendLabel ? (
            <>
              {' · '}
              <span className="text-lq-ink-dim">
                spend {meta.spendLabel} (real)
              </span>
            </>
          ) : (
            <>
              {' · '}
              <span className="text-lq-ink-faint">spend $0.0000 (no events yet)</span>
            </>
          )}
        </p>
      </LiquidGlass>

      {/* Journey pipeline — real 8-stage AI strip + cursor line. */}
      <LiquidGlass as="div" className="flex flex-col gap-4 p-6 font-ui">
        <JourneyPipelineAi journey={journey} />
      </LiquidGlass>

      {/* Phase indicator — purely informational; the cursor decides which
          phase is active. The actual panel rendering below is still gated
          by real spec / plan / build status. */}
      <div className="flex w-full items-stretch gap-2">
        {phases.map((p, i) => {
          const isActive = p.active;
          return (
            <div
              key={p.id}
              className={
                styles.phasePill +
                ' flex flex-1 items-center justify-center gap-1.5 rounded-[12px] border px-3 py-2 font-code text-[10px] uppercase tracking-[0.3em] ' +
                (isActive
                  ? 'border-lq-aurora/50 bg-lq-aurora/[0.07] text-lq-aurora'
                  : 'border-lq-line bg-lq-elev-1 text-lq-ink-faint')
              }
              aria-current={isActive ? 'step' : undefined}
            >
              <span
                aria-hidden
                className={
                  'inline-block h-1 w-1 rounded-full ' +
                  (isActive ? 'bg-lq-aurora' : 'bg-lq-ink-faint')
                }
              />
              <span>{String(i + 1).padStart(2, '0')} · {p.label}</span>
            </div>
          );
        })}
      </div>

      {/* Raw intent — the user's actual prompt. Empty fallback honest. */}
      <LiquidGlass
        as="div"
        className="flex flex-col gap-3 border-l-2 border-l-lq-aurora p-6 font-ui"
      >
        <span className="font-code text-[10px] uppercase tracking-[0.4em] text-lq-aurora">
          raw intent
        </span>
        <p className="whitespace-pre-wrap font-code text-sm leading-relaxed text-lq-ink">
          {spec?.raw_prompt ?? '—'}
        </p>
      </LiquidGlass>

      {/* Slot for the existing domain panels (SpecArea / PlanArea /
          BuildArea / SystemBuildArea / SoftwareBuildArea / InfraBuildArea
          / TestArea / PushArea / DeployArea / RuntimeArea + the
          ForgeTimelinePanel). All of these stay functionally untouched —
          their gates remain live; the next prompt restyles them. */}
      {children}
    </section>
  );
}

function moldStyleFor(mold: 'agent' | 'system' | 'software' | 'infrastructure'): string {
  switch (mold) {
    case 'agent':
      return 'border-lq-amber/40 text-lq-amber';
    case 'system':
      return 'border-lq-aurora/40 text-lq-aurora';
    case 'software':
      return 'border-lq-mint/40 text-lq-mint';
    case 'infrastructure':
      return 'border-lq-rose/40 text-lq-rose';
  }
}
