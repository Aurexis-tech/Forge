// HowItWorks — landing section 2. The canonical 8-station loop (Intent → Live)
// with a plain-language lead per station. Stations 6 and 7 are the human GATES
// (amber) — the only points that wait on the visitor's explicit yes.

import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { SectionHeading } from './SectionHeading';

interface Station {
  n: string;
  title: string;
  body: string;
  gate?: boolean;
}

const STATIONS: ReadonlyArray<Station> = [
  {
    n: '1',
    title: 'Intent',
    body: 'You describe the outcome in plain words. Forge asks a few sharp questions until the idea is fully understood.',
  },
  {
    n: '2',
    title: 'Spec',
    body: 'Your words become a structured spec. You see it before anything is built.',
  },
  {
    n: '3',
    title: 'Plan',
    body: 'Forge works out how to build it and what kind of thing it is, then routes to the right mold.',
  },
  {
    n: '4',
    title: 'Code',
    body: 'The builder generates it on top of vetted scaffolds, then lints and tests it.',
  },
  {
    n: '5',
    title: 'Sandbox',
    body: 'It runs in a sealed, single-use environment first. If it breaks, it breaks safely in there — never on you.',
  },
  {
    n: '6',
    title: 'Repo',
    body: 'Your yes → a private repo in your GitHub, code pushed.',
    gate: true,
  },
  {
    n: '7',
    title: 'Deploy',
    body: 'Your yes → a live URL.',
    gate: true,
  },
  {
    n: '8',
    title: 'Live',
    body: "It's yours, running — and kept alive around the clock if it needs to be.",
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10">
      <SectionHeading
        eyebrow="How it works"
        title="A sentence goes in. A running product comes out."
        intro="Eight stations, one continuous loop. You only ever touch the two that matter — the moments it asks permission."
      />

      <LiquidGlass as="div" className="mt-12 overflow-hidden p-0 font-ui">
        <ol className="divide-y divide-lq-line">
          {STATIONS.map((s) => (
            <li
              key={s.n}
              className={
                'flex items-start gap-5 px-5 py-5 sm:px-7 ' +
                (s.gate ? 'bg-[rgba(251,191,36,0.045)]' : '')
              }
            >
              <span
                aria-hidden
                className={
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-code text-[14px] ' +
                  (s.gate
                    ? 'bg-[rgba(251,191,36,0.14)] text-lq-amber'
                    : 'bg-lq-elev-2 text-lq-ink-dim')
                }
              >
                {s.n}
              </span>
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h3 className="font-ui text-lg font-semibold text-lq-ink">{s.title}</h3>
                  {s.gate ? (
                    <span className="rounded-full bg-[rgba(251,191,36,0.14)] px-2.5 py-0.5 font-code text-[9px] uppercase tracking-[0.2em] text-lq-amber">
                      Gate · your yes
                    </span>
                  ) : null}
                </div>
                <p className="text-[15px] leading-relaxed text-lq-ink-dim">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </LiquidGlass>

      <p className="mt-8 max-w-3xl text-[15px] leading-relaxed text-lq-ink-dim">
        Stations <span className="font-medium text-lq-amber">6</span> and{' '}
        <span className="font-medium text-lq-amber">7</span> are the only ones that
        need you. Nothing official or public ever happens without an explicit,
        in-the-moment yes.
      </p>
    </section>
  );
}
