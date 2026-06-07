// OneRun — landing section 5. Makes the loop concrete: one real prompt walked
// end to end, with the two human gates called out. The payoff line: two clicks
// of yours, everything else is the machine.

import { type ReactNode } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { SectionHeading } from './SectionHeading';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
        {label}
      </span>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="h-px w-full bg-lq-line" />;
}

function GateLine({ n, q }: { n: string; q: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] border border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.05)] px-4 py-3">
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgba(251,191,36,0.16)] font-code text-[11px] text-lq-amber"
      >
        {n}
      </span>
      <span className="font-code text-[10px] uppercase tracking-[0.25em] text-lq-amber">
        It pauses
      </span>
      <span className="text-[15px] text-lq-ink">&ldquo;{q}&rdquo;</span>
      <span className="font-code text-[11px] text-lq-ink-faint sm:ml-auto">
        → you approve
      </span>
    </div>
  );
}

export function OneRun() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10">
      <SectionHeading
        eyebrow="One run, start to finish"
        title="What a single forge actually looks like."
        accent="violet"
      />

      <LiquidGlass as="div" className="mt-12 flex flex-col gap-6 p-7 font-ui sm:p-9">
        <Row label="You type">
          <p className="font-code text-[15px] leading-relaxed text-lq-ink">
            &ldquo;A web app where my team submits expenses, a manager approves
            them, and everyone sees their own history.&rdquo;
          </p>
        </Row>

        <Divider />

        <Row label="Forge">
          <p className="text-[15px] leading-relaxed text-lq-ink-dim">
            drafts the spec → shows it to you → plans the full-stack build →
            generates it → boots and tests it in the sandbox, including a check
            that one user can never see another&rsquo;s data.
          </p>
        </Row>

        <Divider />

        <div className="flex flex-col gap-3">
          <GateLine n="1" q="Create the private repo?" />
          <GateLine n="2" q="Deploy?" />
        </div>

        <Divider />

        <Row label="You get">
          <p className="text-[15px] leading-relaxed text-lq-ink-dim">
            a live URL, a private repo you own, and a dashboard to watch, manage,
            or stop it — built without you writing a line of code.
          </p>
        </Row>
      </LiquidGlass>

      <p className="mt-8 text-[15px] leading-relaxed text-lq-ink-dim">
        <span className="font-medium text-lq-ink">Two clicks of yours.</span>{' '}
        Everything else is the machine.
      </p>
    </section>
  );
}
