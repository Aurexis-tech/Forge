// Pricing — landing section 6. Removes friction with the three lines that are
// actually decided: $5 first run, bring-your-own-key (no markup), and a hard
// spend cap on everything. The post-first-run plan is intentionally omitted
// until final pricing is set (per the copy deck — better than a vague
// "coming soon").

import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { SectionHeading } from './SectionHeading';

interface PriceItem {
  dot: string; // literal Tailwind class
  kicker: string;
  body: string;
}

const ITEMS: ReadonlyArray<PriceItem> = [
  {
    dot: 'bg-lq-aurora',
    kicker: '$5 first run',
    body: 'Try a real forge end to end for five dollars.',
  },
  {
    dot: 'bg-lq-mint',
    kicker: 'Bring your own key',
    body: "Connect your own model-provider key — model usage is billed to you directly, so there's no markup hiding in the middle.",
  },
  {
    dot: 'bg-lq-amber',
    kicker: 'Always capped',
    body: 'A spend cap and kill switch on every build and every running product.',
  },
];

export function Pricing() {
  return (
    <section className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10">
      <SectionHeading
        eyebrow="Pricing & BYOK"
        title="Simple, and capped."
        accent="mint"
      />

      <div className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {ITEMS.map((it) => (
          <LiquidGlass
            as="div"
            key={it.kicker}
            className="flex h-full flex-col gap-3 p-6 font-ui"
          >
            <span
              aria-hidden
              className={'inline-block h-2 w-2 rounded-full ' + it.dot}
            />
            <h3 className="font-ui text-2xl font-bold tracking-tight text-lq-ink">
              {it.kicker}
            </h3>
            <p className="text-[15px] leading-relaxed text-lq-ink-dim">{it.body}</p>
          </LiquidGlass>
        ))}
      </div>

      {/* TODO(pricing): add the post-first-run plan card here once final pricing
          is decided — e.g. "$X/mo subscription, BYOK" or "managed credits".
          Left out on purpose rather than shipping a vague "coming soon". */}
    </section>
  );
}
