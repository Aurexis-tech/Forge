// Faq — landing section 7. Objection-handling, server-rendered with native
// <details> (no client JS). The "+" marker rotates into an "×" on open.

import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { SectionHeading } from './SectionHeading';

interface QA {
  q: string;
  a: string;
}

const FAQS: ReadonlyArray<QA> = [
  {
    q: 'Do I need to know how to code?',
    a: 'No. You describe the outcome in plain words; Forge handles every technical detail.',
  },
  {
    q: 'Is the code mine?',
    a: 'Yes. Forge creates a private repository in your own GitHub and pushes there. You own it from the first commit.',
  },
  {
    q: 'Can it spend money without me knowing?',
    a: 'No. Every build and running product runs under a hard spend cap with an instant kill switch. You set the ceiling.',
  },
  {
    q: 'Will it deploy or publish anything on its own?',
    a: 'Never. Two explicit gates — “create the repo?” and “deploy?” — wait on your yes. Nothing public happens unprompted.',
  },
  {
    q: "Where does the generated code run while it's being built?",
    a: "In an isolated, single-use sandbox. Generated code is treated as untrusted until it's proven safe — so a broken build breaks in there, not on you.",
  },
  {
    q: 'What can it build?',
    a: 'Agents, multi-agent systems, full applications, and infrastructure — rising in power, each on the same safe engine.',
  },
  {
    q: 'What if a build fails?',
    a: 'It fails inside the sandbox. Failures are classified — a transient hiccup retries automatically; a real stop is surfaced to you on a readable timeline.',
  },
];

export function Faq() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10">
      <SectionHeading eyebrow="FAQ" title="Questions, answered." accent="violet" />

      <LiquidGlass as="div" className="mt-12 overflow-hidden p-0 font-ui">
        <div className="divide-y divide-lq-line">
          {FAQS.map((f) => (
            <details key={f.q} className="group px-6 py-5 sm:px-7">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lq-ink [&::-webkit-details-marker]:hidden">
                <span className="font-ui text-[17px] font-semibold">{f.q}</span>
                <span
                  aria-hidden
                  className="font-code text-lg leading-none text-lq-ink-faint transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-lq-ink-dim">
                {f.a}
              </p>
            </details>
          ))}
        </div>
      </LiquidGlass>
    </section>
  );
}
