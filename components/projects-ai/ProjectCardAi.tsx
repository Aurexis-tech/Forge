// ProjectCardAi — the AI-futuristic project card. Pure renderer over the
// projectVm view-model; same shape for all four molds (the four mold
// spaces will reuse this card by passing the same ProjectCardData). Binds
// to REAL fields from loadProjectCards (project + journey + mold); shows
// "—" honestly for stats we don't plumb yet.

import Link from 'next/link';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import type { ProjectCardData } from '@/lib/project-cards';
import {
  projectVm,
  type ProjectAccent,
  type ProjectDotTone,
  type ProjectVmStatus,
} from '@/lib/project-vm';
import styles from './projects.module.css';

const ACCENT_BG: Record<ProjectAccent, string> = {
  aurora: 'bg-lq-aurora',
  violet: 'bg-lq-violet',
  mint: 'bg-lq-mint',
  amber: 'bg-lq-amber',
};
const ACCENT_TEXT: Record<ProjectAccent, string> = {
  aurora: 'text-lq-aurora',
  violet: 'text-lq-violet',
  mint: 'text-lq-mint',
  amber: 'text-lq-amber',
};

const STATUS_LABEL: Record<ProjectVmStatus, string> = {
  detecting: 'Detecting…',
  live: 'Live',
  paused: 'Paused',
  gate: 'Gate',
  forging: 'Forging',
};
const STATUS_TEXT: Record<ProjectVmStatus, string> = {
  detecting: 'text-lq-ink-dim',
  live: 'text-lq-mint',
  paused: 'text-lq-ink-dim',
  gate: 'text-lq-amber',
  forging: 'text-lq-aurora',
};

const DOT_BG: Record<ProjectDotTone, string> = {
  aurora: 'bg-lq-aurora',
  'aurora-soft': 'bg-lq-aurora opacity-60',
  mint: 'bg-lq-mint',
  amber: 'bg-lq-amber',
  rose: 'bg-lq-rose',
  ghost: 'bg-lq-ink-ghost',
};

export function ProjectCardAi({ card }: { card: ProjectCardData }) {
  const vm = projectVm(card);
  const dimmed = vm.status === 'paused';
  return (
    <Link
      href={'/projects/' + card.project.id}
      className="group block h-full rounded-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60"
      aria-label={'Open ' + vm.name}
    >
      <LiquidGlass
        as="div"
        className={
          'flex h-full flex-col gap-4 p-5 font-ui transition-opacity duration-200 ' +
          (dimmed ? 'opacity-60 hover:opacity-80' : '')
        }
      >
        {/* mold (left) + status pill (right) */}
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-lq-line px-2 py-0.5">
            {vm.moldAccent ? (
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 rounded-full ${ACCENT_BG[vm.moldAccent]}`}
              />
            ) : (
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 rounded-full bg-lq-ink-dim ${styles.pulseDot}`}
              />
            )}
            <span
              className={`font-code text-[9px] uppercase tracking-[0.25em] ${
                vm.moldAccent ? ACCENT_TEXT[vm.moldAccent] : 'text-lq-ink-dim'
              }`}
            >
              {vm.moldLabel}
            </span>
          </span>
          <span
            className={`font-code text-[10px] uppercase tracking-[0.25em] ${STATUS_TEXT[vm.status]}`}
          >
            {STATUS_LABEL[vm.status]}
          </span>
        </div>

        {/* name + cursor subline */}
        <div className="flex flex-col gap-1">
          <h3
            className="font-ui truncate text-lg font-semibold text-lq-ink"
            title={vm.name}
          >
            {vm.name}
          </h3>
          <p className="font-code text-[10px] uppercase tracking-[0.2em] text-lq-ink-faint">
            {vm.subline}
          </p>
        </div>

        {/* 3 mini stats — "—" for fields we don't plumb yet */}
        <ul className="flex items-stretch justify-between gap-3 border-t border-lq-line pt-3">
          {vm.stats.map((s, i) => (
            <li key={i} className="flex flex-col gap-0.5">
              <span className="font-code text-[9px] uppercase tracking-[0.25em] text-lq-ink-faint">
                {s.label}
              </span>
              <span className="font-code text-[12px] text-lq-ink-dim">
                {s.value}
              </span>
            </li>
          ))}
        </ul>

        {/* 8-dot mini-pipeline driven by the real journey */}
        <ol
          aria-label="Pipeline"
          className="flex items-center justify-between gap-1 pt-1"
        >
          {vm.dots.map((d, i) => (
            <li
              key={i}
              aria-hidden
              className={`h-2 w-2 rounded-full ${DOT_BG[d.tone]} ${d.pulse ? styles.pulseDot : ''}`}
            />
          ))}
        </ol>
      </LiquidGlass>
    </Link>
  );
}
