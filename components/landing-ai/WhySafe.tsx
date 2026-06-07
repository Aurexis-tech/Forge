// WhySafe — landing section 4. Substantiates the hero headline ("Asks before it
// ships") with the three structural guarantees that hold since v1: the human
// gates, the untrusted-code sandbox, and the hard spend ceiling.

import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { SectionHeading } from './SectionHeading';

interface Guarantee {
  label: string;
  dot: string; // literal Tailwind class
  text: string; // literal Tailwind class
  title: string;
  body: string;
}

const GUARANTEES: ReadonlyArray<Guarantee> = [
  {
    label: 'Gates',
    dot: 'bg-lq-amber',
    text: 'text-lq-amber',
    title: 'You hold the keys.',
    body: "Forge never creates a repo or deploys without your explicit yes, each time. The gate is the point — it's what makes letting software build for you trustworthy.",
  },
  {
    label: 'Sandbox',
    dot: 'bg-lq-mint',
    text: 'text-lq-mint',
    title: 'Generated code is untrusted.',
    body: 'Everything Forge produces runs in an isolated, single-use sandbox before it touches anything real. No exceptions.',
  },
  {
    label: 'Spend cap',
    dot: 'bg-lq-aurora',
    text: 'text-lq-aurora',
    title: 'Money has a hard ceiling.',
    body: 'Every build and every running product lives under a spend cap with an instant kill switch. The system can never quietly run away.',
  },
];

export function WhySafe() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10">
      <SectionHeading
        eyebrow="Why it's safe"
        title="Power, on a leash."
        intro={
          <>
            &ldquo;Asks before it ships&rdquo; isn&rsquo;t a tagline. It&rsquo;s three
            structural guarantees, present since the first version.
          </>
        }
        accent="amber"
      />

      <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
        {GUARANTEES.map((g) => (
          <LiquidGlass
            as="div"
            key={g.title}
            className="flex h-full flex-col gap-4 p-6 font-ui"
          >
            <span className="inline-flex w-fit items-center gap-2">
              <span
                aria-hidden
                className={'inline-block h-2 w-2 rounded-full ' + g.dot}
              />
              <span
                className={
                  'font-code text-[10px] uppercase tracking-[0.3em] ' + g.text
                }
              >
                {g.label}
              </span>
            </span>
            <h3 className="font-ui text-xl font-bold tracking-tight text-lq-ink">
              {g.title}
            </h3>
            <p className="text-[15px] leading-relaxed text-lq-ink-dim">{g.body}</p>
          </LiquidGlass>
        ))}
      </div>
    </section>
  );
}
