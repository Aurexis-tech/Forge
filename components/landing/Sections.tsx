// The calm sections below the hero. Vast negative space, typographic
// restraint, honest status. No animation here — the liveliness lives in
// the hero core; everything else stays still.

import Link from 'next/link';
import { MagneticButton } from './MagneticButton';

// --- How it works ----------------------------------------------------------

const BEATS: Array<{ n: string; head: string; sub: string }> = [
  {
    n: '01',
    head: 'Say it.',
    sub: 'Describe the agent or system you want in plain language.',
  },
  {
    n: '02',
    head: 'The Forge builds it.',
    sub: 'Spec, plan, code, sandbox-test, push to a private repo — under your eye.',
  },
  {
    n: '03',
    head: 'It goes live.',
    sub: 'After you approve, the Forge deploys it. Your URL. Your fuel.',
  },
];

export function HowItWorks() {
  return (
    <section className="relative px-6 py-32">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-12">
        <header className="flex flex-col gap-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-forge-cyan">
            how it works
          </p>
          <h2 className="text-balance text-3xl font-medium text-forge-text sm:text-4xl">
            Three beats from idea to live.
          </h2>
        </header>
        <ol className="grid grid-cols-1 gap-10 md:grid-cols-3">
          {BEATS.map((b) => (
            <li key={b.n} className="flex flex-col gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
                {b.n}
              </p>
              <p className="text-balance text-2xl font-medium text-forge-text">
                {b.head}
              </p>
              <p className="text-sm leading-relaxed text-forge-dim">{b.sub}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// --- Four things -----------------------------------------------------------

interface FourThing {
  label: string;
  blurb: string;
  status: 'Live today' | 'Rolling out';
}

const FOUR: FourThing[] = [
  {
    label: 'Agents',
    blurb: 'Daily briefs, summarisers, triage bots, schedulers, watchers.',
    status: 'Live today',
  },
  {
    label: 'Systems',
    blurb: 'Multi-step pipelines that route, transform, and act on data.',
    status: 'Rolling out',
  },
  {
    label: 'Software',
    blurb: 'Small applications — vaults, dashboards, single-purpose tools.',
    status: 'Rolling out',
  },
  {
    label: 'Infrastructure',
    blurb: 'Crons, watchers, edge workers, scheduled probes — quiet backbone.',
    status: 'Rolling out',
  },
];

export function FourThings() {
  return (
    <section className="relative px-6 py-32">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-12">
        <header className="flex flex-col gap-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-forge-cyan">
            one engine · four things it forges
          </p>
          <h2 className="text-balance text-3xl font-medium text-forge-text sm:text-4xl">
            What can come out of the Forge.
          </h2>
        </header>
        <ul className="flex flex-col">
          {FOUR.map((f, i) => (
            <li
              key={f.label}
              className={
                'flex flex-col gap-3 py-6 sm:flex-row sm:items-baseline sm:justify-between ' +
                (i > 0 ? 'border-t border-white/[0.07]' : '')
              }
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-2xl font-medium text-forge-text">
                  {f.label}
                </p>
                <p className="text-sm text-forge-dim">{f.blurb}</p>
              </div>
              <span
                className={
                  'shrink-0 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] ' +
                  (f.status === 'Live today'
                    ? 'border-forge-amber/60 bg-forge-amber/[0.06] text-forge-amber'
                    : 'border-white/15 text-forge-dim')
                }
              >
                {f.status}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// --- Trust line ------------------------------------------------------------

export function TrustLine() {
  return (
    <section className="relative px-6 py-28">
      <div className="mx-auto max-w-3xl text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-forge-cyan">
          honest about what this is
        </p>
        <p className="mt-6 text-balance text-2xl leading-relaxed text-forge-text/90 sm:text-3xl">
          Bring your own key. The Forge runs on{' '}
          <span className="text-forge-amber">your fuel</span>. Nothing ships,
          nothing goes live, until <span className="text-forge-amber">you</span>{' '}
          approve.
        </p>
      </div>
    </section>
  );
}

// --- One example -----------------------------------------------------------
// A single openable "live today" agent as proof. Static — not a grid, not
// a feed. The restraint of one good example beats a wall of cards.

export function OneExample() {
  return (
    <section className="relative px-6 py-32">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-forge-cyan">
          one example
        </p>
        <h2 className="text-balance text-3xl font-medium text-forge-text sm:text-4xl">
          A real agent forged on the Forge.
        </h2>
        <article className="w-full rounded-2xl border border-white/10 bg-black/40 p-6 text-left backdrop-blur-md">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.7)]"
              />
              <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-emerald-300">
                live
              </span>
            </div>
            <span className="rounded-full border border-forge-amber/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
              Agent
            </span>
          </header>
          <h3 className="mt-4 text-2xl font-medium text-forge-text">
            arXiv morning brief
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-forge-dim">
            Every morning at 8am UTC it scans new arXiv computer-vision papers,
            picks the most interesting five, and emails a short brief. Forged in
            one sentence; locked in after one approval.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.05] pt-4">
            <p className="break-all font-mono text-sm text-forge-amber">
              https://agent-arxiv-brief.forge.dev
            </p>
            <Link
              href="/sign-in"
              className="rounded-xl border border-white/10 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-forge-amber/50 hover:text-forge-amber"
            >
              forge your own →
            </Link>
          </div>
        </article>
      </div>
    </section>
  );
}

// --- CTA band --------------------------------------------------------------

export function CtaBand() {
  return (
    <section className="relative px-6 py-32">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 text-center">
        <h2 className="text-balance text-4xl font-medium leading-tight text-forge-text sm:text-5xl">
          Forge what you described.
        </h2>
        <MagneticButton href="/sign-in">Start forging</MagneticButton>
        <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-dim">
          your key · your fuel · your approval at every step
        </p>
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="relative border-t border-white/[0.05] px-6 py-10">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim/70">
        <p>aurexis forge · v0.1</p>
        <div className="flex items-center gap-5">
          <Link href="/sign-in" className="hover:text-forge-text">
            sign in
          </Link>
          <span aria-hidden>·</span>
          <span>built in the open</span>
        </div>
      </div>
    </footer>
  );
}
